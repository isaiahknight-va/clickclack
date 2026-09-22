package webpush

import (
	"context"
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSendDeliversAnEncryptedPayload(t *testing.T) {
	t.Parallel()
	clientKey, err := ecdh.P256().NewPrivateKey(decodeVector(t, vectorClientPrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	authSecret := decodeVector(t, vectorAuthSecret)
	var header http.Header
	var body []byte
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header.Clone()
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(relay.Close)

	sender := newTestSender(t, relay.Client())
	message := Message{Title: "Owner in #general", Body: "hello", Tag: "clickclack:msg_1", URL: "/app/wsp_1/chn_1"}
	if err := sender.Send(context.Background(), testSubscription(relay.URL+"/push/device", clientKey, authSecret), message); err != nil {
		t.Fatal(err)
	}
	if got := header.Get("Content-Encoding"); got != "aes128gcm" {
		t.Fatalf("content encoding %q", got)
	}
	if got := header.Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("content type %q", got)
	}
	if got := header.Get("TTL"); got != strconv.Itoa(notificationTTL) {
		t.Fatalf("ttl %q", got)
	}
	if got := header.Get("Urgency"); got != "normal" {
		t.Fatalf("urgency %q", got)
	}
	authorization := header.Get("Authorization")
	if !strings.HasPrefix(authorization, "vapid t=") || !strings.Contains(authorization, ", k=") {
		t.Fatalf("authorization %q", authorization)
	}
	var delivered Message
	if err := json.Unmarshal(decryptRecord(t, clientKey, authSecret, body), &delivered); err != nil {
		t.Fatal(err)
	}
	if delivered != message {
		t.Fatalf("delivered %#v, want %#v", delivered, message)
	}
}

func TestSendTruncatesTheBody(t *testing.T) {
	t.Parallel()
	clientKey, err := ecdh.P256().NewPrivateKey(decodeVector(t, vectorClientPrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	authSecret := decodeVector(t, vectorAuthSecret)
	var body []byte
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(relay.Close)
	sender := newTestSender(t, relay.Client())
	long := strings.Repeat("e", 4000)
	if err := sender.Send(context.Background(), testSubscription(relay.URL+"/push/device", clientKey, authSecret), Message{Body: long}); err != nil {
		t.Fatal(err)
	}
	var delivered Message
	if err := json.Unmarshal(decryptRecord(t, clientKey, authSecret, body), &delivered); err != nil {
		t.Fatal(err)
	}
	if len([]rune(delivered.Body)) != MaxBodyRunes || !strings.HasSuffix(delivered.Body, "...") {
		t.Fatalf("unexpected truncation: %d runes", len([]rune(delivered.Body)))
	}
}

func TestSendClassifiesRelayResponses(t *testing.T) {
	t.Parallel()
	clientKey, err := ecdh.P256().NewPrivateKey(decodeVector(t, vectorClientPrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	authSecret := decodeVector(t, vectorAuthSecret)
	status := http.StatusCreated
	retryAfterHeader := ""
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if retryAfterHeader != "" {
			w.Header().Set("Retry-After", retryAfterHeader)
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(relay.Close)
	sender := newTestSender(t, relay.Client())
	subscription := testSubscription(relay.URL+"/push/device", clientKey, authSecret)

	for _, gone := range []int{http.StatusNotFound, http.StatusGone} {
		status = gone
		if err := sender.Send(context.Background(), subscription, Message{Body: "hi"}); !errors.Is(err, ErrSubscriptionGone) {
			t.Fatalf("status %d produced %v", gone, err)
		}
	}

	status = http.StatusServiceUnavailable
	retryAfterHeader = "120"
	err = sender.Send(context.Background(), subscription, Message{Body: "hi"})
	var relayErr *RelayError
	if !errors.As(err, &relayErr) {
		t.Fatalf("expected a relay error, got %v", err)
	}
	if relayErr.Status != http.StatusServiceUnavailable || relayErr.RetryAfter != 2*time.Minute {
		t.Fatalf("unexpected relay error %#v", relayErr)
	}
	if errors.Is(err, ErrSubscriptionGone) {
		t.Fatal("a temporary failure must never read as a dead subscription")
	}

	retryAfterHeader = "soon"
	err = sender.Send(context.Background(), subscription, Message{Body: "hi"})
	if !errors.As(err, &relayErr) || relayErr.RetryAfter != 0 {
		t.Fatalf("unexpected relay error %#v", relayErr)
	}
}

// TestSendKeepsEndpointsOutOfErrors is the redaction guard: net/http wraps a
// transport failure in a *url.Error whose text is the full endpoint, and the
// endpoint path is the device's delivery secret.
func TestSendKeepsEndpointsOutOfErrors(t *testing.T) {
	t.Parallel()
	clientKey, err := ecdh.P256().NewPrivateKey(decodeVector(t, vectorClientPrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	authSecret := decodeVector(t, vectorAuthSecret)
	release := make(chan struct{})
	relay := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	t.Cleanup(func() {
		close(release)
		relay.Close()
	})
	sender := newTestSender(t, relay.Client())
	endpoint := relay.URL + "/push/AAAA-device-delivery-secret"
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err = sender.Send(ctx, testSubscription(endpoint, clientKey, authSecret), Message{Body: "hi"})
	if err == nil {
		t.Fatal("expected the hanging relay to fail the send")
	}
	if strings.Contains(err.Error(), "device-delivery-secret") || strings.Contains(err.Error(), endpoint) {
		t.Fatalf("error leaked the endpoint: %v", err)
	}
	if !strings.Contains(err.Error(), RelayHost(endpoint)) {
		t.Fatalf("error should name the relay host: %v", err)
	}
}

func TestSendRejectsBadInput(t *testing.T) {
	t.Parallel()
	clientKey, err := ecdh.P256().NewPrivateKey(decodeVector(t, vectorClientPrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	authSecret := decodeVector(t, vectorAuthSecret)
	sender := newTestSender(t, nil)
	valid := testSubscription("https://push.example.com/send/abc", clientKey, authSecret)
	for name, subscription := range map[string]Subscription{
		"bad p256dh": {Endpoint: valid.Endpoint, P256dh: "not base64!", Auth: valid.Auth},
		"bad auth":   {Endpoint: valid.Endpoint, P256dh: valid.P256dh, Auth: "not base64!"},
		"short auth": {Endpoint: valid.Endpoint, P256dh: valid.P256dh, Auth: "AAAA"},
		"bad scheme": {Endpoint: "://nonsense", P256dh: valid.P256dh, Auth: valid.Auth},
	} {
		if err := sender.Send(context.Background(), subscription, Message{Body: "hi"}); err == nil {
			t.Fatalf("expected %s to fail", name)
		}
	}
	var unconfigured *Sender
	if err := unconfigured.Send(context.Background(), valid, Message{}); err == nil {
		t.Fatal("expected an unconfigured sender to fail")
	}
	if err := (&Sender{}).Send(context.Background(), valid, Message{}); err == nil {
		t.Fatal("expected a keyless sender to fail")
	}
}

func TestRelayHostFallsBackWhenTheEndpointIsUnusable(t *testing.T) {
	t.Parallel()
	if got := RelayHost("://nonsense"); got != "unknown" {
		t.Fatalf("relay host %q", got)
	}
}

func newTestSender(t *testing.T, client *http.Client) *Sender {
	t.Helper()
	publicKey, privateKey, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	return &Sender{PublicKey: publicKey, PrivateKey: privateKey, Subject: "https://chat.example.com", Client: client}
}

func testSubscription(endpoint string, clientKey *ecdh.PrivateKey, authSecret []byte) Subscription {
	return Subscription{
		Endpoint: endpoint,
		P256dh:   encodeVector(clientKey.PublicKey().Bytes()),
		Auth:     encodeVector(authSecret),
	}
}
