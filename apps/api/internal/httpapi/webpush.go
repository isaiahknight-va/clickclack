package httpapi

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/openclaw/clickclack/apps/api/internal/webpush"
)

const (
	// webPushWorkers bounds how many pushes are in flight at once. Delivery is
	// off the request path, so this is the only backpressure the relay sees.
	webPushWorkers = 4
	// webPushQueueSize bounds the memory a wedged push service can cost. Chat
	// notifications are not durable mail: an overflow is dropped and counted.
	webPushQueueSize = 1024
	// webPushSendTimeout bounds one delivery, including connect and TLS.
	webPushSendTimeout = 10 * time.Second
	// webPushDrainTimeout bounds how long shutdown waits for queued pushes.
	webPushDrainTimeout = 5 * time.Second
	// webPushDropReportInterval throttles the dropped-delivery log so a wedged
	// relay cannot write a line per message.
	webPushDropReportInterval = time.Minute
)

// WebPushConfig is the application server identity used for every push.
type WebPushConfig struct {
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	Subject         string
}

// WebPushSubscriptionStore is the slice of the store the delivery worker
// needs. Keeping it narrow keeps the notifier liftable.
type WebPushSubscriptionStore interface {
	DeletePushSubscription(ctx context.Context, userID, endpoint string) error
	MarkPushSubscriptionSuccess(ctx context.Context, userID, endpoint string) error
	MarkPushSubscriptionFailure(ctx context.Context, userID, endpoint string, retryAfter time.Duration) (int64, error)
}

type webPushSender interface {
	Send(ctx context.Context, subscription webpush.Subscription, message webpush.Message) error
}

type webPushDelivery struct {
	userID       string
	subscription webpush.Subscription
	message      webpush.Message
}

// WebPushNotifier delivers notifications to browser push services from a
// bounded worker pool, off the request path.
type WebPushNotifier struct {
	sender        webPushSender
	subscriptions WebPushSubscriptionStore
	queue         chan webPushDelivery
	workers       sync.WaitGroup
	mu            sync.RWMutex
	closed        bool
	dropMu        sync.Mutex
	dropped       int64
	droppedLogged time.Time
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
	}, subscriptions)
}

func newWebPushNotifier(sender webPushSender, subscriptions WebPushSubscriptionStore) *WebPushNotifier {
	notifier := &WebPushNotifier{
		sender:        sender,
		subscriptions: subscriptions,
		queue:         make(chan webPushDelivery, webPushQueueSize),
	}
	notifier.workers.Add(webPushWorkers)
	for range webPushWorkers {
		go notifier.work()
	}
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
			userID:  notification.UserID,
			message: message,
			subscription: webpush.Subscription{
				Endpoint: subscription.Endpoint,
				P256dh:   subscription.P256dh,
				Auth:     subscription.Auth,
			},
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

// Close stops accepting deliveries and gives the queued ones a bounded time to
// finish, so a deploy in the middle of a burst does not drop the last batch.
func (n *WebPushNotifier) Close() {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return
	}
	n.closed = true
	close(n.queue)
	n.mu.Unlock()
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
	ctx, cancel := context.WithTimeout(context.Background(), webPushSendTimeout)
	defer cancel()
	err := n.sender.Send(ctx, delivery.subscription, delivery.message)
	host := webpush.RelayHost(delivery.subscription.Endpoint)
	switch {
	case err == nil:
		if err := n.subscriptions.MarkPushSubscriptionSuccess(ctx, delivery.userID, delivery.subscription.Endpoint); err != nil {
			log.Printf("web push bookkeeping failed for user %s: %v", delivery.userID, err)
		}
	case errors.Is(err, webpush.ErrSubscriptionGone):
		log.Printf("web push subscription for user %s removed: %s reports it is gone", delivery.userID, host)
		if err := n.subscriptions.DeletePushSubscription(ctx, delivery.userID, delivery.subscription.Endpoint); err != nil {
			log.Printf("web push cleanup failed for user %s: %v", delivery.userID, err)
		}
	default:
		var relayErr *webpush.RelayError
		retryAfter := time.Duration(0)
		if errors.As(err, &relayErr) {
			retryAfter = relayErr.RetryAfter
		}
		log.Printf("web push delivery failed for user %s: %v", delivery.userID, err)
		count, markErr := n.subscriptions.MarkPushSubscriptionFailure(ctx, delivery.userID, delivery.subscription.Endpoint, retryAfter)
		if markErr != nil {
			log.Printf("web push bookkeeping failed for user %s: %v", delivery.userID, markErr)
			return
		}
		log.Printf("web push to %s backing off for user %s after %d consecutive failures", host, delivery.userID, count)
	}
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
