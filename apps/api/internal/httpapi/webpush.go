package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/openclaw/clickclack/apps/api/internal/store"
	"github.com/openclaw/clickclack/apps/api/internal/webpush"
)

const (
	// webPushWorkers bounds how many pushes are in flight at once. Delivery is
	// off the request path, so this is the only backpressure the relay sees.
	webPushWorkers = 4
	// webPushQueueSize bounds the memory a wedged push service can cost. Chat
	// notifications are not durable mail: an overflow is dropped and counted.
	webPushQueueSize = 1024
	// webPushBookkeepingTimeout bounds recording what the push service said.
	// It starts after Send returns, so a relay that used the whole send budget
	// still gets its failure and backoff written.
	webPushBookkeepingTimeout = 5 * time.Second
	// webPushDrainTimeout bounds how long shutdown waits for queued pushes.
	webPushDrainTimeout = 5 * time.Second
	// webPushDropReportInterval throttles the dropped-delivery log so a wedged
	// relay cannot write a line per message.
	webPushDropReportInterval = time.Minute
	// webPushPruneTimeout bounds one pass of the dead-device sweep.
	webPushPruneTimeout = 30 * time.Second
)

// webPushSendTimeout bounds the device check and one delivery, including
// connect and TLS. It is a variable so a test can stand in a hanging relay.
var webPushSendTimeout = 10 * time.Second

// webPushPruneInterval is how often the notifier sweeps devices that can no
// longer receive. It is a variable so a test can watch the sweep repeat.
var webPushPruneInterval = time.Hour

// WebPushConfig is the application server identity used for every push.
type WebPushConfig struct {
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	Subject         string
}

// WebPushSubscriptionStore is the slice of the store the delivery worker
// needs. Keeping it narrow keeps the notifier liftable.
type WebPushSubscriptionStore interface {
	GetPushSubscriptionDelivery(ctx context.Context, userID, endpoint, currentKeyID string) (store.PushSubscriptionTarget, error)
	GetMessage(ctx context.Context, messageID, userID string) (store.Message, error)
	DeletePushSubscription(ctx context.Context, userID, endpoint string) error
	MarkPushSubscriptionSuccess(ctx context.Context, userID, endpoint string) error
	MarkPushSubscriptionFailure(ctx context.Context, userID, endpoint string, retryAfter time.Duration) (int64, error)
	PrunePushSubscriptions(ctx context.Context, currentKeyID string, now time.Time) (store.PushPruneResult, error)
}

type webPushSender interface {
	Send(ctx context.Context, subscription webpush.Subscription, message webpush.Message) error
}

// webPushDelivery is one queued push. It names the device and the message
// rather than carrying the device's keys: authority is re-read from the store
// when a worker picks it up, because it can change while the push waits. The
// message's text can change too, so the body sent is built from that same
// re-read; the queued payload supplies the title, tag, and route.
type webPushDelivery struct {
	userID    string
	endpoint  string
	messageID string
	message   webpush.Message
}

// WebPushNotifier delivers notifications to browser push services from a
// bounded worker pool, off the request path, and sweeps the devices that can
// no longer receive.
type WebPushNotifier struct {
	sender        webPushSender
	subscriptions WebPushSubscriptionStore
	keyID         string
	queue         chan webPushDelivery
	workers       sync.WaitGroup
	mu            sync.RWMutex
	closed        bool
	dropMu        sync.Mutex
	dropped       int64
	droppedLogged time.Time
	stopPruning   context.CancelFunc
	pruning       sync.WaitGroup
}

// NewWebPushNotifier builds a notifier that sends through the same outbound
// policy as callbacks: no proxy, no redirects, and no destination inside the
// deployment's own network.
func NewWebPushNotifier(config WebPushConfig, subscriptions WebPushSubscriptionStore) *WebPushNotifier {
	client := newCallbackHTTPClient()
	client.Timeout = webPushSendTimeout
	return newWebPushNotifier(&webpush.Sender{
		PublicKey:  config.VAPIDPublicKey,
		PrivateKey: config.VAPIDPrivateKey,
		Subject:    config.Subject,
		Client:     client,
	}, subscriptions, webPushKeyID(config.VAPIDPublicKey))
}

// webPushKeyID names the application server key a device registers under:
// the fingerprint the server logs at startup, so a stored key id and the log
// line agree. No key names nothing.
func webPushKeyID(publicKey string) string {
	if strings.TrimSpace(publicKey) == "" {
		return ""
	}
	return webpush.KeyFingerprint(publicKey)
}

func newWebPushNotifier(sender webPushSender, subscriptions WebPushSubscriptionStore, keyID string) *WebPushNotifier {
	pruneCtx, stopPruning := context.WithCancel(context.Background())
	notifier := &WebPushNotifier{
		sender:        sender,
		subscriptions: subscriptions,
		keyID:         keyID,
		queue:         make(chan webPushDelivery, webPushQueueSize),
		stopPruning:   stopPruning,
	}
	notifier.workers.Add(webPushWorkers)
	for range webPushWorkers {
		go notifier.work()
	}
	notifier.pruning.Add(1)
	go notifier.pruneEvery(pruneCtx, webPushPruneInterval)
	return notifier
}

// Notify queues one delivery per device. It never blocks the caller and never
// returns a delivery result: the worker owns the outcome.
func (n *WebPushNotifier) Notify(_ context.Context, notification PushNotification) error {
	n.mu.RLock()
	defer n.mu.RUnlock()
	if n.closed {
		return errors.New("web push notifier is closed")
	}
	message := webpush.Message{
		Title: notification.Title,
		Body:  notification.Message,
		Tag:   notification.Tag,
		URL:   notification.URL,
	}
	dropped := 0
	for _, subscription := range notification.Subscriptions {
		delivery := webPushDelivery{
			userID:    notification.UserID,
			endpoint:  subscription.Endpoint,
			messageID: notification.MessageID,
			message:   message,
		}
		select {
		case n.queue <- delivery:
		default:
			dropped++
		}
	}
	if dropped > 0 {
		n.reportDropped(dropped)
	}
	return nil
}

// Close stops the sweep, stops accepting deliveries, and gives the queued ones
// a bounded time to finish, so a deploy in the middle of a burst does not drop
// the last batch.
func (n *WebPushNotifier) Close() {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return
	}
	n.closed = true
	close(n.queue)
	n.mu.Unlock()
	n.stopPruning()
	n.pruning.Wait()
	drained := make(chan struct{})
	go func() {
		n.workers.Wait()
		close(drained)
	}()
	select {
	case <-drained:
	case <-time.After(webPushDrainTimeout):
		log.Print("web push delivery drain timed out")
	}
}

// pruneEvery sweeps once at start and then on every tick until Close. A pass
// that runs when Close is called is canceled with it.
func (n *WebPushNotifier) pruneEvery(ctx context.Context, interval time.Duration) {
	defer n.pruning.Done()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		n.prune(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// prune removes the devices that can no longer receive, by the rules in
// PrunePushSubscriptions. A failure is logged and the next tick tries again.
func (n *WebPushNotifier) prune(parent context.Context) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("web push prune panicked: %v", recovered)
		}
	}()
	ctx, cancel := context.WithTimeout(parent, webPushPruneTimeout)
	defer cancel()
	result, err := n.subscriptions.PrunePushSubscriptions(ctx, n.keyID, time.Now())
	if err != nil {
		if parent.Err() == nil {
			log.Printf("web push prune failed: %v", err)
		}
		return
	}
	if result.Total() > 0 {
		log.Printf("web push pruned %d devices: %d refused by their push service for a week, %d under a retired key, %d whose session ended",
			result.Total(), result.Failing, result.RetiredKey, result.SessionEnded)
	}
}

func (n *WebPushNotifier) work() {
	defer n.workers.Done()
	for delivery := range n.queue {
		n.deliver(delivery)
	}
}

// deliver sends one push and records what the push service said. It recovers
// from a panic because the pool is detached from the request: an unrecovered
// panic here would take the whole server down.
func (n *WebPushNotifier) deliver(delivery webPushDelivery) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("web push delivery panicked for user %s: %v", delivery.userID, recovered)
		}
	}()
	sendCtx, cancelSend := context.WithTimeout(context.Background(), webPushSendTimeout)
	defer cancelSend()
	subscription, current, reason := n.authorize(sendCtx, delivery)
	if reason != "" {
		log.Printf("web push delivery skipped for user %s: %s", delivery.userID, reason)
		return
	}
	payload := delivery.message
	payload.Body = webPushBody(current)
	err := n.sender.Send(sendCtx, subscription, payload)
	ctx, cancel := context.WithTimeout(context.Background(), webPushBookkeepingTimeout)
	defer cancel()
	host := webpush.RelayHost(delivery.endpoint)
	switch {
	case err == nil:
		log.Printf("web push delivered for user %s via %s", delivery.userID, host)
		if err := n.subscriptions.MarkPushSubscriptionSuccess(ctx, delivery.userID, delivery.endpoint); err != nil {
			log.Printf("web push bookkeeping failed for user %s: %v", delivery.userID, err)
		}
	case errors.Is(err, webpush.ErrSubscriptionGone):
		log.Printf("web push subscription for user %s removed: %s reports it is gone", delivery.userID, host)
		if err := n.subscriptions.DeletePushSubscription(ctx, delivery.userID, delivery.endpoint); err != nil {
			log.Printf("web push cleanup failed for user %s: %v", delivery.userID, err)
		}
	default:
		var relayErr *webpush.RelayError
		retryAfter := time.Duration(0)
		if errors.As(err, &relayErr) {
			retryAfter = relayErr.RetryAfter
		}
		log.Printf("web push delivery failed for user %s: %v", delivery.userID, err)
		count, markErr := n.subscriptions.MarkPushSubscriptionFailure(ctx, delivery.userID, delivery.endpoint, retryAfter)
		if markErr != nil {
			log.Printf("web push bookkeeping failed for user %s: %v", delivery.userID, markErr)
			return
		}
		log.Printf("web push to %s backing off for user %s after %d consecutive failures", host, delivery.userID, count)
	}
}

// authorize re-reads everything that allowed a push when it was queued: the
// device must still be registered to this user under a live session and the
// key the server signs with, with its backoff elapsed, and the user must still
// be able to read the message, which must not have been deleted. It answers
// the device's current keys and the message as it reads now, or the class of
// reason it may not be sent. A lookup that fails for any other reason also
// refuses: without an answer, the message text stays on the server.
func (n *WebPushNotifier) authorize(ctx context.Context, delivery webPushDelivery) (webpush.Subscription, store.Message, string) {
	target, err := n.subscriptions.GetPushSubscriptionDelivery(ctx, delivery.userID, delivery.endpoint, n.keyID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return webpush.Subscription{}, store.Message{}, "the device is no longer registered"
	case errors.Is(err, store.ErrPushSessionEnded):
		return webpush.Subscription{}, store.Message{}, "the session that registered the device has ended"
	case errors.Is(err, store.ErrPushSubscriptionKeyRetired):
		return webpush.Subscription{}, store.Message{}, "the device was registered under a retired key"
	case errors.Is(err, store.ErrPushSubscriptionBackingOff):
		return webpush.Subscription{}, store.Message{}, "the device is backing off"
	case err != nil:
		return webpush.Subscription{}, store.Message{}, "the device could not be verified"
	}
	if delivery.messageID == "" {
		return webpush.Subscription{}, store.Message{}, "the message could not be verified"
	}
	message, err := n.subscriptions.GetMessage(ctx, delivery.messageID, delivery.userID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return webpush.Subscription{}, store.Message{}, "the user can no longer read the message"
	case err != nil:
		return webpush.Subscription{}, store.Message{}, "the message could not be verified"
	case message.DeletedAt != nil:
		return webpush.Subscription{}, store.Message{}, "the message was deleted"
	}
	return webpush.Subscription{Endpoint: target.Endpoint, P256dh: target.P256dh, Auth: target.Auth}, message, ""
}

func (n *WebPushNotifier) reportDropped(dropped int) {
	n.dropMu.Lock()
	defer n.dropMu.Unlock()
	n.dropped += int64(dropped)
	if time.Since(n.droppedLogged) < webPushDropReportInterval {
		return
	}
	n.droppedLogged = time.Now()
	log.Printf("web push queue is full: %d deliveries dropped so far", n.dropped)
}
