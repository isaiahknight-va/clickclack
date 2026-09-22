package store

import (
	"errors"
	"testing"
	"time"
)

func TestCheckPushDelivery(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	live := PushDeliveryState{
		UserID:           "usr_1",
		SessionTokenHash: "hash",
		SessionUserID:    "usr_1",
		SessionExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano),
	}
	for name, testCase := range map[string]struct {
		change func(*PushDeliveryState)
		want   error
	}{
		"live session":       {func(*PushDeliveryState) {}, nil},
		"development row":    {func(state *PushDeliveryState) { *state = PushDeliveryState{UserID: "usr_1"} }, nil},
		"backoff elapsed":    {func(state *PushDeliveryState) { state.NextAttemptAt = now.Add(-time.Minute).Format(time.RFC3339Nano) }, nil},
		"session missing":    {func(state *PushDeliveryState) { state.SessionUserID, state.SessionExpiresAt = "", "" }, ErrPushSessionEnded},
		"session of another": {func(state *PushDeliveryState) { state.SessionUserID = "usr_2" }, ErrPushSessionEnded},
		"session revoked":    {func(state *PushDeliveryState) { state.SessionRevokedAt = now.Format(time.RFC3339Nano) }, ErrPushSessionEnded},
		"session expired":    {func(state *PushDeliveryState) { state.SessionExpiresAt = now.Format(time.RFC3339Nano) }, ErrPushSessionEnded},
		"unreadable expiry":  {func(state *PushDeliveryState) { state.SessionExpiresAt = "soon" }, ErrPushSessionEnded},
		"backing off":        {func(state *PushDeliveryState) { state.NextAttemptAt = now.Add(time.Minute).Format(time.RFC3339Nano) }, ErrPushSubscriptionBackingOff},
		"unreadable backoff": {func(state *PushDeliveryState) { state.NextAttemptAt = "later" }, ErrPushSubscriptionBackingOff},
		"ended and backed off": {func(state *PushDeliveryState) {
			state.SessionRevokedAt = now.Format(time.RFC3339Nano)
			state.NextAttemptAt = now.Add(time.Minute).Format(time.RFC3339Nano)
		}, ErrPushSessionEnded},
	} {
		state := live
		testCase.change(&state)
		if got := CheckPushDelivery(state, now); !errors.Is(got, testCase.want) || (testCase.want == nil && got != nil) {
			t.Fatalf("%s: got %v, want %v", name, got, testCase.want)
		}
	}
}

func TestNormalizePushSubscriptionInputRequiresASession(t *testing.T) {
	t.Parallel()
	input := PushSubscriptionInput{
		UserID:   "usr_1",
		Endpoint: "https://push.example.com/send/1",
		P256dh:   "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		Auth:     "BTBZMqHH6r4Tts7J_aSIgg",
	}
	if _, err := NormalizePushSubscriptionInput(input); !errors.Is(err, ErrPushSubscriptionNeedsSession) {
		t.Fatalf("a sessionless registration must be refused: %v", err)
	}
	input.SessionToken = "session"
	if _, err := NormalizePushSubscriptionInput(input); err != nil {
		t.Fatalf("a session binds the device: %v", err)
	}
	input.SessionToken = ""
	input.DevelopmentActor = true
	if _, err := NormalizePushSubscriptionInput(input); err != nil {
		t.Fatalf("the development identity has no session to bind: %v", err)
	}
}
