package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/openclaw/clickclack/apps/api/internal/realtime"
	"github.com/openclaw/clickclack/apps/api/internal/store"
	sqlitestore "github.com/openclaw/clickclack/apps/api/internal/store/sqlite"
	"github.com/openclaw/clickclack/apps/api/internal/webpush"
)

type recordedPushResult struct {
	kind       string
	userID     string
	endpoint   string
	retryAfter time.Duration
}

type fakeSubscriptionStore struct {
	mu         sync.Mutex
	results    []recordedPushResult
	err        error
	lookupErr  error
	messageErr error
}

// GetPushSubscriptionDelivery answers the device the notification named, with
// the RFC 8291 example keys, unless the test says the store refuses it.
func (f *fakeSubscriptionStore) GetPushSubscriptionDelivery(_ context.Context, _, endpoint string) (store.PushSubscriptionTarget, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lookupErr != nil {
		return store.PushSubscriptionTarget{}, f.lookupErr
	}
	return store.PushSubscriptionTarget{Endpoint: endpoint, P256dh: exampleClientKey, Auth: exampleClientAuth}, nil
}

func (f *fakeSubscriptionStore) GetMessage(context.Context, string, string) (store.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return store.Message{}, f.messageErr
}

func (f *fakeSubscriptionStore) DeletePushSubscription(_ context.Context, userID, endpoint string) error {
	return f.record("delete", userID, endpoint, 0)
}

func (f *fakeSubscriptionStore) MarkPushSubscriptionSuccess(_ context.Context, userID, endpoint string) error {
	return f.record("success", userID, endpoint, 0)
}

func (f *fakeSubscriptionStore) MarkPushSubscriptionFailure(_ context.Context, userID, endpoint string, retryAfter time.Duration) (int64, error) {
	return 1, f.record("failure", userID, endpoint, retryAfter)
}

func (f *fakeSubscriptionStore) record(kind, userID, endpoint string, retryAfter time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, recordedPushResult{kind: kind, userID: userID, endpoint: endpoint, retryAfter: retryAfter})
	return f.err
}

func (f *fakeSubscriptionStore) recorded() []recordedPushResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordedPushResult(nil), f.results...)
}

type fakeSender struct {
	mu            sync.Mutex
	err           error
	sent          int
	hold          chan struct{}
	panc          bool
	subscriptions []webpush.Subscription
}

func (f *fakeSender) Send(_ context.Context, subscription webpush.Subscription, _ webpush.Message) error {
	f.mu.Lock()
	hold := f.hold
	err := f.err
	shouldPanic := f.panc
	f.sent++
	f.subscriptions = append(f.subscriptions, subscription)
	f.mu.Unlock()
	if hold != nil {
		<-hold
	}
	if shouldPanic {
		panic("push exploded")
	}
	return err
}

func (f *fakeSender) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent
}

func pushNotificationFor(userID, endpoint string) PushNotification {
	return PushNotification{
		UserID:    userID,
		MessageID: "msg_1",
		Title:     "Owner in #general",
		Message:   "hello",
		Tag:       "clickclack:msg_1",
		URL:       "/app/wsp_1/chn_1",
		Subscriptions: []store.PushSubscriptionTarget{{
			Endpoint: endpoint,
			P256dh:   exampleClientKey,
			Auth:     exampleClientAuth,
		}},
	}
}

func TestWebPushNotifierRecordsWhatTheRelaySaid(t *testing.T) {
	t.Parallel()
	for name, testCase := range map[string]struct {
		err        error
		want       string
		retryAfter time.Duration
	}{
		"delivered":    {nil, "success", 0},
		"gone":         {webpush.ErrSubscriptionGone, "delete", 0},
		"rate limited": {&webpush.RelayError{Host: "push.example.com", Status: http.StatusTooManyRequests, RetryAfter: time.Minute}, "failure", time.Minute},
		"unavailable":  {&webpush.RelayError{Host: "push.example.com", Status: http.StatusServiceUnavailable}, "failure", 0},
		"transport":    {errors.New("network down"), "failure", 0},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			subscriptions := &fakeSubscriptionStore{}
			notifier := newWebPushNotifier(&fakeSender{err: testCase.err}, subscriptions)
			if err := notifier.Notify(context.Background(), pushNotificationFor("usr_1", "https://push.example.com/send/device")); err != nil {
				t.Fatal(err)
			}
			notifier.Close()
			recorded := subscriptions.recorded()
			if len(recorded) != 1 || recorded[0].kind != testCase.want {
				t.Fatalf("recorded %#v, want %s", recorded, testCase.want)
			}
			if recorded[0].userID != "usr_1" || recorded[0].endpoint != "https://push.example.com/send/device" {
				t.Fatalf("unexpected bookkeeping target %#v", recorded[0])
			}
			if recorded[0].retryAfter != testCase.retryAfter {
				t.Fatalf("retry after %s, want %s", recorded[0].retryAfter, testCase.retryAfter)
			}
		})
	}
}

func TestWebPushNotifierToleratesBookkeepingFailures(t *testing.T) {
	t.Parallel()
	subscriptions := &fakeSubscriptionStore{err: errors.New("database is away")}
	notifier := newWebPushNotifier(&fakeSender{}, subscriptions)
	if err := notifier.Notify(context.Background(), pushNotificationFor("usr_1", "https://push.example.com/send/device")); err != nil {
		t.Fatal(err)
	}
	notifier.Notify(context.Background(), PushNotification{UserID: "usr_2"})
	notifier.Close()
	if len(subscriptions.recorded()) != 1 {
		t.Fatalf("unexpected bookkeeping %#v", subscriptions.recorded())
	}
}

// TestWebPushNotifierSurvivesAPanickingDelivery guards the detached pool: an
// unrecovered panic in a worker would take the whole server down.
func TestWebPushNotifierSurvivesAPanickingDelivery(t *testing.T) {
	t.Parallel()
	sender := &fakeSender{panc: true}
	subscriptions := &fakeSubscriptionStore{}
	notifier := newWebPushNotifier(sender, subscriptions)
	for range 8 {
		if err := notifier.Notify(context.Background(), pushNotificationFor("usr_1", "https://push.example.com/send/device")); err != nil {
			t.Fatal(err)
		}
	}
	notifier.Close()
	if sender.count() != 8 {
		t.Fatalf("every delivery must be attempted, got %d", sender.count())
	}
	if len(subscriptions.recorded()) != 0 {
		t.Fatalf("a panicking delivery records nothing: %#v", subscriptions.recorded())
	}
}

func TestWebPushNotifierDropsWhenTheQueueIsFull(t *testing.T) {
	t.Parallel()
	hold := make(chan struct{})
	sender := &fakeSender{hold: hold}
	notifier := newWebPushNotifier(sender, &fakeSubscriptionStore{})
	notification := pushNotificationFor("usr_1", "https://push.example.com/send/device")
	for range webPushQueueSize + webPushWorkers + 50 {
		if err := notifier.Notify(context.Background(), notification); err != nil {
			t.Fatal(err)
		}
	}
	notifier.dropMu.Lock()
	dropped := notifier.dropped
	notifier.dropMu.Unlock()
	if dropped == 0 {
		t.Fatal("expected the overflow to be counted")
	}
	close(hold)
	notifier.Close()
}

func TestWebPushNotifierRefusesAfterClose(t *testing.T) {
	t.Parallel()
	notifier := newWebPushNotifier(&fakeSender{}, &fakeSubscriptionStore{})
	notifier.Close()
	notifier.Close()
	if err := notifier.Notify(context.Background(), pushNotificationFor("usr_1", "https://push.example.com/send/device")); err == nil {
		t.Fatal("expected a closed notifier to refuse work")
	}
}

// TestWebPushNotifierKeepsEndpointsOutOfTheLog is the redaction guard at the
// layer that writes the log line: a timeout arrives as a *url.Error whose text
// is the full endpoint, and the endpoint path is a delivery secret.
func TestWebPushNotifierKeepsEndpointsOutOfTheLog(t *testing.T) {
	release := make(chan struct{})
	relay := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer func() {
		close(release)
		relay.Close()
	}()
	publicKey, privateKey, err := webpush.GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	client := relay.Client()
	client.Timeout = 100 * time.Millisecond
	notifier := newWebPushNotifier(&webpush.Sender{
		PublicKey:  publicKey,
		PrivateKey: privateKey,
		Subject:    "https://chat.example.com",
		Client:     client,
	}, &fakeSubscriptionStore{})

	var captured strings.Builder
	previousOutput := log.Writer()
	previousFlags := log.Flags()
	log.SetOutput(&captured)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(previousOutput)
		log.SetFlags(previousFlags)
	}()

	endpoint := relay.URL + "/send/device-delivery-secret"
	if err := notifier.Notify(context.Background(), pushNotificationFor("usr_1", endpoint)); err != nil {
		t.Fatal(err)
	}
	notifier.Close()
	logged := captured.String()
	if logged == "" {
		t.Fatal("expected the failure to be logged")
	}
	if strings.Contains(logged, "device-delivery-secret") || strings.Contains(logged, endpoint) {
		t.Fatalf("the log leaked the endpoint: %s", logged)
	}
}

// TestWebPushNotifierBacksOffATimedOutRelay sends to a relay that never
// answers, so the send budget is spent before the failure is recorded. The
// failure and its backoff must still reach the store. Not parallel: it
// shortens the package send timeout.
func TestWebPushNotifierBacksOffATimedOutRelay(t *testing.T) {
	release := make(chan struct{})
	relay := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer func() {
		close(release)
		relay.Close()
	}()
	previousTimeout := webPushSendTimeout
	webPushSendTimeout = 200 * time.Millisecond
	defer func() { webPushSendTimeout = previousTimeout }()

	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "clickclack.db")
	st, err := sqlitestore.Open("sqlite://" + databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := st.EnsureBootstrap(ctx, "Owner", "timeout-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	workspaces, err := st.ListWorkspaces(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	channels, err := st.ListChannels(ctx, workspaces[0].ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	message, _, err := st.CreateMessage(ctx, store.CreateMessageInput{ChannelID: channels[0].ID, AuthorID: owner.ID, Body: "into the void"})
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.CreateSession(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	endpoint := relay.URL + "/send/device"
	if _, err := st.UpsertPushSubscription(ctx, store.PushSubscriptionInput{
		UserID: owner.ID, Endpoint: endpoint, P256dh: exampleClientKey, Auth: exampleClientAuth, SessionToken: session.Token,
	}); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := webpush.GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	notifier := newWebPushNotifier(&webpush.Sender{
		PublicKey:  publicKey,
		PrivateKey: privateKey,
		Subject:    "https://chat.example.com",
		Client:     relay.Client(),
	}, st)
	if err := notifier.Notify(ctx, PushNotification{
		UserID:        owner.ID,
		MessageID:     message.ID,
		Subscriptions: []store.PushSubscriptionTarget{{Endpoint: endpoint}},
	}); err != nil {
		t.Fatal(err)
	}
	notifier.Close()

	db, err := sql.Open("sqlite", "file:"+databasePath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var failures int64
	var nextAttempt sql.NullString
	if err := db.QueryRow(
		`SELECT failure_count, next_attempt_at FROM user_push_subscriptions WHERE endpoint = ?`, endpoint,
	).Scan(&failures, &nextAttempt); err != nil {
		t.Fatal(err)
	}
	if failures != 1 {
		t.Fatalf("the timed-out delivery recorded %d failures, want 1", failures)
	}
	if !nextAttempt.Valid || nextAttempt.String == "" {
		t.Fatal("the timed-out device has no backoff, so every message would retry it")
	}
}

// TestMessageNotificationsFanOutPerChannel proves the two delivery paths stay
// separate: a Pushover-only user produces exactly one Pushover call and no web
// push, and a push-only user the reverse.
func TestMessageNotificationsFanOutPerChannel(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dataDir := t.TempDir()
	st, err := sqlitestore.Open("sqlite://" + filepath.Join(dataDir, "clickclack.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := st.EnsureBootstrap(ctx, "Owner", "fanout-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	workspaces, err := st.ListWorkspaces(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	channels, err := st.ListChannels(ctx, workspaces[0].ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	pushoverUser, err := st.CreateUser(ctx, store.CreateUserInput{DisplayName: "Pushover", Email: "fanout-pushover@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	pushUser, err := st.CreateUser(ctx, store.CreateUserInput{DisplayName: "Push", Email: "fanout-push@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []store.User{pushoverUser, pushUser} {
		if err := st.AddWorkspaceMember(ctx, workspaces[0].ID, user.ID, store.WorkspaceRoleMember); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.UpdateCurrentUser(ctx, store.UpdateCurrentUserInput{
		UserID: pushoverUser.ID,
		NotificationSettings: &store.NotificationSettings{
			PushoverEnabled: true,
			PushoverUserKey: "u12345678901234567890123456789",
		},
	}); err != nil {
		t.Fatal(err)
	}
	pushSession, err := st.CreateSession(ctx, pushUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertPushSubscription(ctx, store.PushSubscriptionInput{
		UserID:       pushUser.ID,
		Endpoint:     "https://push.example.com/send/fanout",
		P256dh:       exampleClientKey,
		Auth:         exampleClientAuth,
		UserAgent:    "phone",
		SessionToken: pushSession.Token,
	}); err != nil {
		t.Fatal(err)
	}

	pushover := &recordingNotifier{}
	web := &recordingNotifier{}
	publicKey, _, err := webpush.GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(st, realtime.NewHub(), Options{
		PushNotifier:     pushover,
		WebPushNotifier:  web,
		WebPushPublicKey: publicKey,
	}).Handler())
	t.Cleanup(server.Close)

	posted := postJSON[struct {
		Message store.Message `json:"message"`
	}](t, server.URL+"/api/channels/"+channels[0].ID+"/messages", map[string]any{"body": "morning"})

	if len(pushover.notifications) != 1 {
		t.Fatalf("expected one Pushover call, got %#v", pushover.notifications)
	}
	if pushover.notifications[0].RecipientKey == "" || pushover.notifications[0].Title != "ClickClack" {
		t.Fatalf("the Pushover payload changed: %#v", pushover.notifications[0])
	}
	if len(pushover.notifications[0].Subscriptions) != 0 {
		t.Fatal("Pushover must not receive web push devices")
	}
	if len(web.notifications) != 1 {
		t.Fatalf("expected one web push call, got %#v", web.notifications)
	}
	delivered := web.notifications[0]
	if delivered.UserID != pushUser.ID || len(delivered.Subscriptions) != 1 {
		t.Fatalf("unexpected web push recipient: %#v", delivered)
	}
	if delivered.Title != "Owner in #general" {
		t.Fatalf("unexpected title %q", delivered.Title)
	}
	if delivered.Message != "morning" {
		t.Fatalf("unexpected body %q", delivered.Message)
	}
	if delivered.Tag != "clickclack:"+posted.Message.ID {
		t.Fatalf("unexpected tag %q", delivered.Tag)
	}
	if !strings.HasPrefix(delivered.URL, "/app/"+workspaces[0].ID+"/") {
		t.Fatalf("unexpected route %q", delivered.URL)
	}
	if delivered.RecipientKey != "" {
		t.Fatal("a web push recipient has no Pushover key")
	}
}

func TestWebPushTitleNamesThePlaceItKnows(t *testing.T) {
	t.Parallel()
	author := store.Message{AuthorID: "usr_1", Author: &store.User{DisplayName: "Ari"}}
	displayTitle := "  Release Room  "
	for name, testCase := range map[string]struct {
		message store.Message
		place   store.Channel
		want    string
	}{
		"channel":       {author, store.Channel{Name: "general"}, "Ari in #general"},
		"display title": {author, store.Channel{Name: "general", DisplayTitle: &displayTitle}, "Ari in #Release Room"},
		"direct message": {
			store.Message{AuthorID: "usr_1", Author: &store.User{DisplayName: "Ari"}, DirectConversationID: "dm_1"},
			store.Channel{},
			"Ari in Direct message",
		},
		"blank author": {
			store.Message{AuthorID: "usr_1", Author: &store.User{DisplayName: "  "}},
			store.Channel{Name: "general"},
			"ClickClack in #general",
		},
		"unreadable channel": {store.Message{AuthorID: "usr_1"}, store.Channel{}, "ClickClack"},
	} {
		if got := webPushTitle(testCase.message, testCase.place); got != testCase.want {
			t.Fatalf("%s: title is %q, want %q", name, got, testCase.want)
		}
	}
}

func TestWebPushBodyAndRouteDescribeTheMessage(t *testing.T) {
	t.Parallel()
	parent := "msg_root"
	if got := webPushBody(store.Message{Body: "  hello  "}); got != "hello" {
		t.Fatalf("body is %q", got)
	}
	if got := webPushBody(store.Message{}); got != "New message" {
		t.Fatalf("empty body is %q", got)
	}
	channel := store.Message{WorkspaceID: "wsp_1", ChannelID: "chn_1"}
	if got := webPushURL(channel, store.Channel{RouteID: "C123"}); got != "/app/wsp_1/C123" {
		t.Fatalf("channel route is %q", got)
	}
	if got := webPushURL(channel, store.Channel{}); got != "/app/wsp_1/chn_1" {
		t.Fatalf("channel route without a route id is %q", got)
	}
	thread := store.Message{WorkspaceID: "wsp_1", ChannelID: "chn_1", ParentMessageID: &parent, ThreadRootID: parent}
	if got := webPushURL(thread, store.Channel{RouteID: "C123"}); got != "/app/wsp_1/C123" {
		t.Fatalf("thread route is %q", got)
	}
	dm := store.Message{WorkspaceID: "wsp_1", DirectConversationID: "dm_1"}
	if got := webPushURL(dm, store.Channel{}); got != "/app/wsp_1/dm_1" {
		t.Fatalf("direct route is %q", got)
	}
	if got := webPushURL(store.Message{}, store.Channel{}); got != "/app" {
		t.Fatalf("unknown route is %q", got)
	}
	if got := webPushTag(store.Message{ID: "msg_1"}); got != "clickclack:msg_1" {
		t.Fatalf("tag is %q", got)
	}
}

// TestWebPushNotifierRevalidatesBeforeSending covers every reason a queued push
// is refused at send time. None of them may reach the push service, and each
// names its reason in one log line.
func TestWebPushNotifierRevalidatesBeforeSending(t *testing.T) {
	for name, testCase := range map[string]struct {
		lookupErr  error
		messageErr error
		messageID  string
		reason     string
	}{
		"device removed":       {lookupErr: sql.ErrNoRows, messageID: "msg_1", reason: "the device is no longer registered"},
		"session ended":        {lookupErr: store.ErrPushSessionEnded, messageID: "msg_1", reason: "the session that registered the device has ended"},
		"backing off":          {lookupErr: store.ErrPushSubscriptionBackingOff, messageID: "msg_1", reason: "the device is backing off"},
		"device lookup failed": {lookupErr: errors.New("database is away"), messageID: "msg_1", reason: "the device could not be verified"},
		"message unreadable":   {messageErr: sql.ErrNoRows, messageID: "msg_1", reason: "the user can no longer read the message"},
		"message lookup failed": {
			messageErr: errors.New("database is away"), messageID: "msg_1", reason: "the message could not be verified",
		},
		"no message": {reason: "the message could not be verified"},
	} {
		t.Run(name, func(t *testing.T) {
			var captured strings.Builder
			previousOutput := log.Writer()
			log.SetOutput(&captured)
			defer log.SetOutput(previousOutput)

			sender := &fakeSender{}
			subscriptions := &fakeSubscriptionStore{lookupErr: testCase.lookupErr, messageErr: testCase.messageErr}
			notifier := newWebPushNotifier(sender, subscriptions)
			notification := pushNotificationFor("usr_1", "https://push.example.com/send/device")
			notification.MessageID = testCase.messageID
			if err := notifier.Notify(context.Background(), notification); err != nil {
				t.Fatal(err)
			}
			notifier.Close()
			if sender.count() != 0 {
				t.Fatalf("a refused delivery reached the push service %d times", sender.count())
			}
			if len(subscriptions.recorded()) != 0 {
				t.Fatalf("a refused delivery records nothing: %#v", subscriptions.recorded())
			}
			want := "web push delivery skipped for user usr_1: " + testCase.reason
			if !strings.Contains(captured.String(), want) {
				t.Fatalf("expected %q in the log, got %q", want, captured.String())
			}
			if strings.Contains(captured.String(), "push.example.com/send") {
				t.Fatalf("the log leaked the endpoint: %s", captured.String())
			}
		})
	}
}

// TestWebPushNotifierSendsTheKeysOnFileNow proves the queue does not carry
// device keys: a device re-registered while a push waits is sent under the
// keys the store holds at send time.
func TestWebPushNotifierSendsTheKeysOnFileNow(t *testing.T) {
	t.Parallel()
	sender := &fakeSender{}
	notifier := newWebPushNotifier(sender, &fakeSubscriptionStore{})
	notification := pushNotificationFor("usr_1", "https://push.example.com/send/device")
	notification.Subscriptions[0].Auth = "queued-auth-is-not-used"
	if err := notifier.Notify(context.Background(), notification); err != nil {
		t.Fatal(err)
	}
	notifier.Close()
	sender.mu.Lock()
	defer sender.mu.Unlock()
	if len(sender.subscriptions) != 1 || sender.subscriptions[0].Auth != exampleClientAuth {
		t.Fatalf("expected the stored keys, sent %#v", sender.subscriptions)
	}
}

// gatedSender holds every push to a /hold/ endpoint until the gate opens and
// records the endpoints it actually sent to.
type gatedSender struct {
	mu       sync.Mutex
	gate     chan struct{}
	inFlight chan struct{}
	sent     []string
}

func (g *gatedSender) Send(_ context.Context, subscription webpush.Subscription, _ webpush.Message) error {
	if strings.Contains(subscription.Endpoint, "/hold/") {
		g.inFlight <- struct{}{}
		<-g.gate
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sent = append(g.sent, subscription.Endpoint)
	return nil
}

func (g *gatedSender) sentTo(endpoint string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	count := 0
	for _, sent := range g.sent {
		if sent == endpoint {
			count++
		}
	}
	return count
}

// TestQueuedWebPushIsRevalidatedBeforeSending holds every worker on a slow
// relay, queues a real message's push behind them, withdraws the recipient's
// authority, and then lets the relay go. The push that was already queued
// must not be sent; with nothing withdrawn, it is sent once.
func TestQueuedWebPushIsRevalidatedBeforeSending(t *testing.T) {
	t.Parallel()
	for name, withdraw := range map[string]func(t *testing.T, fixture queuedPushFixture){
		"control": func(*testing.T, queuedPushFixture) {},
		"session revoked": func(t *testing.T, fixture queuedPushFixture) {
			if err := fixture.store.RevokeSession(context.Background(), fixture.recipientSession); err != nil {
				t.Fatal(err)
			}
		},
		"subscription deleted": func(t *testing.T, fixture queuedPushFixture) {
			if err := fixture.store.DeletePushSubscription(context.Background(), fixture.recipient, fixture.recipientEndpoint); err != nil {
				t.Fatal(err)
			}
		},
		"message deleted": func(t *testing.T, fixture queuedPushFixture) {
			if _, _, err := fixture.store.DeleteMessage(context.Background(), store.DeleteMessageInput{
				MessageID: fixture.messageID, UserID: fixture.owner,
			}); err != nil {
				t.Fatal(err)
			}
		},
		"membership removed": func(t *testing.T, fixture queuedPushFixture) {
			// No endpoint removes a human member, so this is the row change an
			// operator would make; message access reads the same row.
			db, err := sql.Open("sqlite", "file:"+fixture.databasePath+"?_pragma=busy_timeout(5000)")
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.Exec(`DELETE FROM workspace_members WHERE user_id = ?`, fixture.recipient); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			fixture := newQueuedPushFixture(t)
			withdraw(t, fixture)
			close(fixture.sender.gate)
			fixture.notifier.Close()
			want := 0
			if name == "control" {
				want = 1
			}
			if got := fixture.sender.sentTo(fixture.recipientEndpoint); got != want {
				t.Fatalf("the recipient's device was sent %d pushes, want %d", got, want)
			}
		})
	}
}

type queuedPushFixture struct {
	store             *sqlitestore.Store
	databasePath      string
	sender            *gatedSender
	notifier          *WebPushNotifier
	owner             string
	messageID         string
	recipient         string
	recipientSession  string
	recipientEndpoint string
}

// newQueuedPushFixture returns with every worker held on the relay and the
// recipient's push for a freshly posted message waiting in the queue.
func newQueuedPushFixture(t *testing.T) queuedPushFixture {
	t.Helper()
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "clickclack.db")
	st, err := sqlitestore.Open("sqlite://" + databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := st.EnsureBootstrap(ctx, "Owner", "queued-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	workspaces, err := st.ListWorkspaces(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	channels, err := st.ListChannels(ctx, workspaces[0].ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	member := func(name, email string) string {
		user, err := st.CreateUser(ctx, store.CreateUserInput{DisplayName: name, Email: email})
		if err != nil {
			t.Fatal(err)
		}
		if err := st.AddWorkspaceMember(ctx, workspaces[0].ID, user.ID, store.WorkspaceRoleMember); err != nil {
			t.Fatal(err)
		}
		return user.ID
	}
	blocker := member("Blocker", "queued-blocker@example.com")
	recipient := member("Recipient", "queued-recipient@example.com")
	// Posted before any device exists, so it queues nothing on its own.
	warmUp, _, err := st.CreateMessage(ctx, store.CreateMessageInput{ChannelID: channels[0].ID, AuthorID: owner.ID, Body: "warm up"})
	if err != nil {
		t.Fatal(err)
	}
	register := func(userID, endpoint string) string {
		session, err := st.CreateSession(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.UpsertPushSubscription(ctx, store.PushSubscriptionInput{
			UserID: userID, Endpoint: endpoint, P256dh: exampleClientKey, Auth: exampleClientAuth, SessionToken: session.Token,
		}); err != nil {
			t.Fatal(err)
		}
		return session.Token
	}
	var blockers []store.PushSubscriptionTarget
	for index := range webPushWorkers {
		endpoint := "https://push.example.com/hold/" + strconv.Itoa(index)
		register(blocker, endpoint)
		blockers = append(blockers, store.PushSubscriptionTarget{Endpoint: endpoint})
	}
	recipientEndpoint := "https://push.example.com/send/recipient"
	recipientSession := register(recipient, recipientEndpoint)

	sender := &gatedSender{gate: make(chan struct{}), inFlight: make(chan struct{}, 4*webPushWorkers)}
	notifier := newWebPushNotifier(sender, st)
	t.Cleanup(notifier.Close)
	publicKey, _, err := webpush.GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(st, realtime.NewHub(), Options{
		WebPushNotifier:  notifier,
		WebPushPublicKey: publicKey,
	}).Handler())
	t.Cleanup(server.Close)

	if err := notifier.Notify(ctx, PushNotification{UserID: blocker, MessageID: warmUp.ID, Subscriptions: blockers}); err != nil {
		t.Fatal(err)
	}
	for range webPushWorkers {
		select {
		case <-sender.inFlight:
		case <-time.After(5 * time.Second):
			t.Fatal("the workers never reached the held relay")
		}
	}
	posted := postJSON[struct {
		Message store.Message `json:"message"`
	}](t, server.URL+"/api/channels/"+channels[0].ID+"/messages", map[string]any{"body": "queued behind a slow relay"})
	if got := sender.sentTo(recipientEndpoint); got != 0 {
		t.Fatalf("the recipient's push left before the workers were free: %d", got)
	}
	return queuedPushFixture{
		store:             st,
		databasePath:      databasePath,
		sender:            sender,
		notifier:          notifier,
		owner:             owner.ID,
		messageID:         posted.Message.ID,
		recipient:         recipient,
		recipientSession:  recipientSession,
		recipientEndpoint: recipientEndpoint,
	}
}
