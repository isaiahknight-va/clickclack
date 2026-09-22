package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
	mu      sync.Mutex
	results []recordedPushResult
	err     error
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
	mu   sync.Mutex
	err  error
	sent int
	hold chan struct{}
	panc bool
}

func (f *fakeSender) Send(context.Context, webpush.Subscription, webpush.Message) error {
	f.mu.Lock()
	hold := f.hold
	err := f.err
	shouldPanic := f.panc
	f.sent++
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
		UserID:  userID,
		Title:   "Owner in #general",
		Message: "hello",
		Tag:     "clickclack:msg_1",
		URL:     "/app/wsp_1/chn_1",
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
	if _, err := st.UpsertPushSubscription(ctx, store.PushSubscriptionInput{
		UserID:    pushUser.ID,
		Endpoint:  "https://push.example.com/send/fanout",
		P256dh:    exampleClientKey,
		Auth:      exampleClientAuth,
		UserAgent: "phone",
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
