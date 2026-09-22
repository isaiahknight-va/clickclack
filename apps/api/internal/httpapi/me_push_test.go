package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/openclaw/clickclack/apps/api/internal/realtime"
	"github.com/openclaw/clickclack/apps/api/internal/store"
	sqlitestore "github.com/openclaw/clickclack/apps/api/internal/store/sqlite"
	"github.com/openclaw/clickclack/apps/api/internal/webpush"
)

// exampleClientKey is the RFC 8291 Appendix A subscription public key: a real
// point on P-256, so registration accepts it.
const (
	exampleClientKey  = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
	exampleClientAuth = "BTBZMqHH6r4Tts7J_aSIgg"
)

type pushTestServer struct {
	server *httptest.Server
	store  *sqlitestore.Store
	owner  store.User
}

func newPushTestServer(t *testing.T, enabled bool) pushTestServer {
	t.Helper()
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
	owner, err := st.EnsureBootstrap(ctx, "Owner", "push-endpoints@example.com")
	if err != nil {
		t.Fatal(err)
	}
	options := Options{}
	if enabled {
		publicKey, _, err := webpush.GenerateKeys()
		if err != nil {
			t.Fatal(err)
		}
		options.WebPushPublicKey = publicKey
		options.WebPushNotifier = &recordingNotifier{}
	}
	server := httptest.NewServer(New(st, realtime.NewHub(), options).Handler())
	t.Cleanup(server.Close)
	return pushTestServer{server: server, store: st, owner: owner}
}

func TestPushEndpointsRegisterAndRemoveADevice(t *testing.T) {
	t.Parallel()
	fixture := newPushTestServer(t, true)
	state := getJSON[struct {
		Enabled       bool                     `json:"enabled"`
		VAPIDKey      string                   `json:"vapid_public_key"`
		Subscriptions []store.PushSubscription `json:"subscriptions"`
	}](t, fixture.server.URL+"/api/me/push")
	if !state.Enabled || state.VAPIDKey == "" || len(state.Subscriptions) != 0 {
		t.Fatalf("unexpected initial state %#v", state)
	}

	endpoint := "https://push.example.com/send/device-one"
	stored := putPushSubscription(t, fixture.server.URL, endpoint, "iPhone")
	if stored.Subscription.UserAgent != "iPhone" || stored.Subscription.ID == "" {
		t.Fatalf("unexpected stored summary %#v", stored.Subscription)
	}
	body, err := json.Marshal(stored.Subscription)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"endpoint", "p256dh", "auth", endpoint, exampleClientKey, exampleClientAuth} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("the summary must not carry %q: %s", secret, body)
		}
	}

	state = getJSON[struct {
		Enabled       bool                     `json:"enabled"`
		VAPIDKey      string                   `json:"vapid_public_key"`
		Subscriptions []store.PushSubscription `json:"subscriptions"`
	}](t, fixture.server.URL+"/api/me/push")
	if len(state.Subscriptions) != 1 {
		t.Fatalf("expected the device to be listed, got %#v", state.Subscriptions)
	}

	expectStatus(t, http.MethodDelete, fixture.server.URL+"/api/me/push/subscriptions", strings.NewReader(`{"endpoint":"`+endpoint+`"}`), http.StatusNoContent)
	expectStatus(t, http.MethodDelete, fixture.server.URL+"/api/me/push/subscriptions", strings.NewReader(`{"endpoint":"`+endpoint+`"}`), http.StatusNoContent)
	state = getJSON[struct {
		Enabled       bool                     `json:"enabled"`
		VAPIDKey      string                   `json:"vapid_public_key"`
		Subscriptions []store.PushSubscription `json:"subscriptions"`
	}](t, fixture.server.URL+"/api/me/push")
	if len(state.Subscriptions) != 0 {
		t.Fatalf("expected the device to be gone, got %#v", state.Subscriptions)
	}
}

func TestPushEndpointsRejectUnusableSubscriptions(t *testing.T) {
	t.Parallel()
	fixture := newPushTestServer(t, true)
	valid := `"keys":{"p256dh":"` + exampleClientKey + `","auth":"` + exampleClientAuth + `"}`
	offCurve := offCurveClientKey(t)
	// Built rather than written out so no credential-shaped literal sits in the source.
	endpointWithUserinfo := (&url.URL{Scheme: "https", User: url.UserPassword("user", "pass"), Host: "push.example.com", Path: "/send/x"}).String()
	for name, body := range map[string]string{
		"loopback endpoint":  `{"endpoint":"https://127.0.0.1/send/x",` + valid + `}`,
		"private endpoint":   `{"endpoint":"https://10.0.0.1/send/x",` + valid + `}`,
		"localhost endpoint": `{"endpoint":"https://localhost/send/x",` + valid + `}`,
		"bare host endpoint": `{"endpoint":"https://push/send/x",` + valid + `}`,
		"plain http":         `{"endpoint":"http://push.example.com/send/x",` + valid + `}`,
		"no endpoint":        `{"endpoint":"",` + valid + `}`,
		"credentials":        `{"endpoint":"` + endpointWithUserinfo + `",` + valid + `}`,
		"off curve key":      `{"endpoint":"https://push.example.com/send/x","keys":{"p256dh":"` + offCurve + `","auth":"` + exampleClientAuth + `"}}`,
		"short key":          `{"endpoint":"https://push.example.com/send/x","keys":{"p256dh":"AAAA","auth":"` + exampleClientAuth + `"}}`,
		"short auth":         `{"endpoint":"https://push.example.com/send/x","keys":{"p256dh":"` + exampleClientKey + `","auth":"AAAA"}}`,
		"no keys":            `{"endpoint":"https://push.example.com/send/x"}`,
		"not json":           `{`,
	} {
		t.Run(name, func(t *testing.T) {
			expectStatus(t, http.MethodPut, fixture.server.URL+"/api/me/push/subscriptions", strings.NewReader(body), http.StatusBadRequest)
		})
	}
	expectStatus(t, http.MethodDelete, fixture.server.URL+"/api/me/push/subscriptions", strings.NewReader(`{"endpoint":""}`), http.StatusBadRequest)
	expectStatus(t, http.MethodDelete, fixture.server.URL+"/api/me/push/subscriptions", strings.NewReader(`{`), http.StatusBadRequest)
}

func TestPushEndpointsAreInvisibleWhenTheFeatureIsOff(t *testing.T) {
	t.Parallel()
	fixture := newPushTestServer(t, false)
	state := getJSON[struct {
		Enabled       bool                     `json:"enabled"`
		VAPIDKey      string                   `json:"vapid_public_key"`
		Subscriptions []store.PushSubscription `json:"subscriptions"`
	}](t, fixture.server.URL+"/api/me/push")
	if state.Enabled || state.VAPIDKey != "" || state.Subscriptions == nil || len(state.Subscriptions) != 0 {
		t.Fatalf("unexpected disabled state %#v", state)
	}
	body := `{"endpoint":"https://push.example.com/send/x","keys":{"p256dh":"` + exampleClientKey + `","auth":"` + exampleClientAuth + `"}}`
	expectStatus(t, http.MethodPut, fixture.server.URL+"/api/me/push/subscriptions", strings.NewReader(body), http.StatusNotFound)
	expectStatus(t, http.MethodDelete, fixture.server.URL+"/api/me/push/subscriptions", strings.NewReader(`{"endpoint":"https://push.example.com/send/x"}`), http.StatusNotFound)
	subscriptions, err := fixture.store.ListPushSubscriptions(context.Background(), fixture.owner.ID)
	if err != nil || len(subscriptions) != 0 {
		t.Fatalf("a disabled feature must never write a row: %#v %v", subscriptions, err)
	}
}

func TestPushEndpointsRejectBotTokens(t *testing.T) {
	t.Parallel()
	fixture := newPushTestServer(t, true)
	ctx := context.Background()
	workspaces, err := fixture.store.ListWorkspaces(ctx, fixture.owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, botToken, err := fixture.store.CreateBot(ctx, store.CreateBotInput{
		WorkspaceID: workspaces[0].ID,
		DisplayName: "Pusher",
		CreatedBy:   fixture.owner.ID,
		OwnerUserID: fixture.owner.ID,
		Scopes:      []string{"profile:read", "messages:write"},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"endpoint":"https://push.example.com/send/x","keys":{"p256dh":"` + exampleClientKey + `","auth":"` + exampleClientAuth + `"}}`
	expectStatusWithBearer(t, botToken.Token, http.MethodPut, fixture.server.URL+"/api/me/push/subscriptions", strings.NewReader(body), http.StatusForbidden)
}

func putPushSubscription(t *testing.T, baseURL, endpoint, label string) struct {
	Subscription store.PushSubscription `json:"subscription"`
} {
	t.Helper()
	body := map[string]any{
		"endpoint":   endpoint,
		"keys":       map[string]string{"p256dh": exampleClientKey, "auth": exampleClientAuth},
		"user_agent": label,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPut, baseURL+"/api/me/push/subscriptions", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("unexpected status %d: %s", response.StatusCode, raw)
	}
	var out struct {
		Subscription store.PushSubscription `json:"subscription"`
	}
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// offCurveClientKey is a correctly shaped uncompressed point that is not on
// P-256. Accepting one would hand the delivery worker a key that cannot agree.
func offCurveClientKey(t *testing.T) string {
	t.Helper()
	raw, err := webpush.DecodeKey(exampleClientKey)
	if err != nil {
		t.Fatal(err)
	}
	raw[10] ^= 0xff
	return base64.RawURLEncoding.EncodeToString(raw)
}
