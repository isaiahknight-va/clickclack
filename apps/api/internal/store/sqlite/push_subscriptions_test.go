package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/openclaw/clickclack/apps/api/internal/store"
)

func TestPushSubscriptionsUpsertAndCap(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	owner, err := st.EnsureBootstrap(ctx, "Owner", "push-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}

	first, err := st.UpsertPushSubscription(ctx, pushInput(owner.ID, "https://push.example.com/send/1", "iPhone"))
	if err != nil {
		t.Fatal(err)
	}
	if first.UserAgent != "iPhone" || first.FailureCount != 0 || first.LastSuccessAt != nil {
		t.Fatalf("unexpected stored subscription %#v", first)
	}

	again, err := st.UpsertPushSubscription(ctx, pushInput(owner.ID, "https://push.example.com/send/1", "iPhone 17"))
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != first.ID || again.CreatedAt != first.CreatedAt || again.UserAgent != "iPhone 17" {
		t.Fatalf("re-subscribing must replace in place, got %#v", again)
	}
	subscriptions, err := st.ListPushSubscriptions(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subscriptions) != 1 {
		t.Fatalf("expected one device, got %d", len(subscriptions))
	}

	for index := 2; index <= store.MaxPushSubscriptionsPerUser+3; index++ {
		if _, err := st.UpsertPushSubscription(ctx, pushInput(owner.ID, "https://push.example.com/send/"+strconv.Itoa(index), "device")); err != nil {
			t.Fatal(err)
		}
	}
	subscriptions, err = st.ListPushSubscriptions(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subscriptions) != store.MaxPushSubscriptionsPerUser {
		t.Fatalf("expected the cap of %d, got %d", store.MaxPushSubscriptionsPerUser, len(subscriptions))
	}
	if subscriptions[0].ID == first.ID {
		t.Fatal("the oldest device must be evicted first")
	}

	if err := st.DeletePushSubscription(ctx, owner.ID, subscriptions[0].ID); err != nil {
		t.Fatal(err)
	}
	remaining, err := st.ListPushSubscriptions(ctx, owner.ID)
	if err != nil || len(remaining) != store.MaxPushSubscriptionsPerUser {
		t.Fatalf("deleting by id must not remove a row: %d %v", len(remaining), err)
	}
	if err := st.DeletePushSubscription(ctx, owner.ID, "https://push.example.com/send/4"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeletePushSubscription(ctx, owner.ID, "https://push.example.com/send/4"); err != nil {
		t.Fatalf("deleting twice must be idempotent: %v", err)
	}
	remaining, err = st.ListPushSubscriptions(ctx, owner.ID)
	if err != nil || len(remaining) != store.MaxPushSubscriptionsPerUser-1 {
		t.Fatalf("expected one fewer device: %d %v", len(remaining), err)
	}
}

func TestPushSubscriptionsRejectBadInput(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	owner, err := st.EnsureBootstrap(ctx, "Owner", "push-input@example.com")
	if err != nil {
		t.Fatal(err)
	}
	valid := pushInput(owner.ID, "https://push.example.com/send/1", "device")
	for name, input := range map[string]store.PushSubscriptionInput{
		"no user":     {Endpoint: valid.Endpoint, P256dh: valid.P256dh, Auth: valid.Auth},
		"no endpoint": {UserID: owner.ID, P256dh: valid.P256dh, Auth: valid.Auth},
		"opaque endpoint": {
			UserID: owner.ID, Endpoint: "not a url", P256dh: valid.P256dh, Auth: valid.Auth,
		},
		"no keys": {UserID: owner.ID, Endpoint: valid.Endpoint},
		"bad keys": {
			UserID: owner.ID, Endpoint: valid.Endpoint, P256dh: "not base64!", Auth: valid.Auth,
		},
		"no session": {
			UserID: owner.ID, Endpoint: valid.Endpoint, P256dh: valid.P256dh, Auth: valid.Auth,
		},
	} {
		if _, err := st.UpsertPushSubscription(ctx, input); err == nil {
			t.Fatalf("expected %s to fail", name)
		}
	}
	long := valid
	long.UserAgent = strings.Repeat("l", 400)
	stored, err := st.UpsertPushSubscription(ctx, long)
	if err != nil {
		t.Fatal(err)
	}
	if len([]rune(stored.UserAgent)) != 200 {
		t.Fatalf("device label must be truncated, got %d runes", len([]rune(stored.UserAgent)))
	}
}

func TestPushSubscriptionsCascadeWithTheUser(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	member, err := st.CreateUser(ctx, store.CreateUserInput{DisplayName: "Member", Email: "push-cascade@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertPushSubscription(ctx, pushInput(member.ID, "https://push.example.com/send/cascade", "device")); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, member.ID); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM user_push_subscriptions WHERE user_id = ?`, member.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("expected the subscription to be removed with the user, %d left", remaining)
	}
}

func TestPushNotificationRecipientsSeparatePushoverAndWebPush(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	owner, err := st.EnsureBootstrap(ctx, "Owner", "recipients-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := st.EnsureDefaultWorkspaceMember(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	pushoverOnly := addPushMember(t, st, workspace.ID, "Pushover", "pushover-only@example.com")
	pushOnly := addPushMember(t, st, workspace.ID, "Push", "push-only@example.com")
	both := addPushMember(t, st, workspace.ID, "Both", "push-both@example.com")

	enablePushover(t, st, pushoverOnly, "p12345678901234567890123456789")
	enablePushover(t, st, both, "b12345678901234567890123456789")
	// The push-only member never saves notification settings, so the settings
	// row does not exist. An inner join here would drop the member entirely.
	if _, err := st.UpsertPushSubscription(ctx, pushInput(pushOnly, "https://push.example.com/send/phone", "phone")); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertPushSubscription(ctx, pushInput(pushOnly, "https://push.example.com/send/laptop", "laptop")); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertPushSubscription(ctx, pushInput(both, "https://push.example.com/send/both", "phone")); err != nil {
		t.Fatal(err)
	}

	channels, err := st.ListChannels(ctx, workspace.ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	message, _, err := st.CreateMessage(ctx, store.CreateMessageInput{
		ChannelID: channels[0].ID,
		AuthorID:  owner.ID,
		Body:      "hello",
	})
	if err != nil {
		t.Fatal(err)
	}
	recipients := recipientsByUser(t, st, message.ID, nil)
	if got := recipients[pushoverOnly]; got.PushoverUserKey == "" || len(got.Subscriptions) != 0 {
		t.Fatalf("pushover-only recipient is %#v", got)
	}
	if got := recipients[pushOnly]; got.PushoverUserKey != "" || len(got.Subscriptions) != 2 {
		t.Fatalf("push-only recipient is %#v", got)
	}
	if got := recipients[both]; got.PushoverUserKey == "" || len(got.Subscriptions) != 1 {
		t.Fatalf("combined recipient is %#v", got)
	}
	if got := recipients[owner.ID]; got.UserID != "" {
		t.Fatal("the author must never be a recipient")
	}
	subscription := recipients[both].Subscriptions[0]
	if subscription.Endpoint == "" || subscription.P256dh == "" || subscription.Auth == "" {
		t.Fatalf("delivery target is incomplete: %#v", subscription)
	}

	if err := st.UpsertChannelNotificationSettings(ctx, store.ChannelNotificationInput{
		ChannelID:  channels[0].ID,
		UserID:     pushOnly,
		Preference: store.ChannelNotifyMuted,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertChannelNotificationSettings(ctx, store.ChannelNotificationInput{
		ChannelID:  channels[0].ID,
		UserID:     both,
		Preference: store.ChannelNotifyMentions,
	}); err != nil {
		t.Fatal(err)
	}
	recipients = recipientsByUser(t, st, message.ID, nil)
	if _, ok := recipients[pushOnly]; ok {
		t.Fatal("a muted channel must silence web push too")
	}
	if _, ok := recipients[both]; ok {
		t.Fatal("mentions-only must skip an unmentioned member")
	}
	recipients = recipientsByUser(t, st, message.ID, []string{both})
	if got := recipients[both]; len(got.Subscriptions) != 1 {
		t.Fatalf("a mentioned member keeps their devices: %#v", got)
	}
}

func TestPushSubscriptionDeliveryFollowsTheSessionAndBackoff(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	owner, err := st.EnsureBootstrap(ctx, "Owner", "session-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := st.EnsureDefaultWorkspaceMember(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	member := addPushMember(t, st, workspace.ID, "Member", "session-member@example.com")
	session, err := st.CreateSession(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	input := pushInput(member, "https://push.example.com/send/session", "phone")
	input.SessionToken = session.Token
	if _, err := st.UpsertPushSubscription(ctx, input); err != nil {
		t.Fatal(err)
	}
	channels, err := st.ListChannels(ctx, workspace.ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	message, _, err := st.CreateMessage(ctx, store.CreateMessageInput{
		ChannelID: channels[0].ID,
		AuthorID:  owner.ID,
		Body:      "hello",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := recipientsByUser(t, st, message.ID, nil)[member]; len(got.Subscriptions) != 1 {
		t.Fatalf("a live session must deliver: %#v", got)
	}

	count, err := st.MarkPushSubscriptionFailure(ctx, member, input.Endpoint, 0)
	if err != nil || count != 1 {
		t.Fatalf("failure count is %d: %v", count, err)
	}
	if got := recipientsByUser(t, st, message.ID, nil)[member]; len(got.Subscriptions) != 0 {
		t.Fatal("a backed-off device must be skipped, not deleted")
	}
	subscriptions, err := st.ListPushSubscriptions(ctx, member)
	if err != nil || len(subscriptions) != 1 || subscriptions[0].FailureCount != 1 {
		t.Fatalf("the row must survive a failure: %#v %v", subscriptions, err)
	}
	if err := st.MarkPushSubscriptionSuccess(ctx, member, input.Endpoint); err != nil {
		t.Fatal(err)
	}
	subscriptions, err = st.ListPushSubscriptions(ctx, member)
	if err != nil || subscriptions[0].FailureCount != 0 || subscriptions[0].LastSuccessAt == nil {
		t.Fatalf("success must clear the backoff: %#v %v", subscriptions, err)
	}
	if got := recipientsByUser(t, st, message.ID, nil)[member]; len(got.Subscriptions) != 1 {
		t.Fatal("a recovered device delivers again")
	}

	if err := st.RevokeSession(ctx, session.Token); err != nil {
		t.Fatal(err)
	}
	if got := recipientsByUser(t, st, message.ID, nil)[member]; len(got.Subscriptions) != 0 {
		t.Fatal("a signed-out device must stop receiving message text")
	}
}

// TestPushSubscriptionDeliveryIsRereadBeforeSending covers the send-time
// check the delivery worker makes on a push that already sat in its queue.
func TestPushSubscriptionDeliveryIsRereadBeforeSending(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	owner, err := st.EnsureBootstrap(ctx, "Owner", "reread-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := st.EnsureDefaultWorkspaceMember(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	member := addPushMember(t, st, workspace.ID, "Member", "reread-member@example.com")
	session, err := st.CreateSession(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	input := pushInput(member, "https://push.example.com/send/reread", "phone")
	input.SessionToken = session.Token
	input.DevelopmentActor = false
	if _, err := st.UpsertPushSubscription(ctx, input); err != nil {
		t.Fatal(err)
	}

	target, err := st.GetPushSubscriptionDelivery(ctx, member, input.Endpoint)
	if err != nil || target.Endpoint != input.Endpoint || target.P256dh != input.P256dh || target.Auth != input.Auth {
		t.Fatalf("a live device must be deliverable: %#v %v", target, err)
	}
	if _, err := st.GetPushSubscriptionDelivery(ctx, owner.ID, input.Endpoint); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("another user's device must not be found: %v", err)
	}
	if _, err := st.GetPushSubscriptionDelivery(ctx, member, "https://push.example.com/send/unknown"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("an unknown device must not be found: %v", err)
	}

	if _, err := st.MarkPushSubscriptionFailure(ctx, member, input.Endpoint, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetPushSubscriptionDelivery(ctx, member, input.Endpoint); !errors.Is(err, store.ErrPushSubscriptionBackingOff) {
		t.Fatalf("a backed-off device must wait: %v", err)
	}
	if err := st.MarkPushSubscriptionSuccess(ctx, member, input.Endpoint); err != nil {
		t.Fatal(err)
	}

	if _, err := st.db.ExecContext(ctx, `UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?`, member); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetPushSubscriptionDelivery(ctx, member, input.Endpoint); !errors.Is(err, store.ErrPushSessionEnded) {
		t.Fatalf("an expired session must stop delivery: %v", err)
	}
	if _, err := st.db.ExecContext(ctx, `UPDATE sessions SET expires_at = '2999-01-01T00:00:00Z' WHERE user_id = ?`, member); err != nil {
		t.Fatal(err)
	}
	if err := st.RevokeSession(ctx, session.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetPushSubscriptionDelivery(ctx, member, input.Endpoint); !errors.Is(err, store.ErrPushSessionEnded) {
		t.Fatalf("a revoked session must stop delivery: %v", err)
	}

	if err := st.DeletePushSubscription(ctx, member, input.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetPushSubscriptionDelivery(ctx, member, input.Endpoint); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("a deleted device must not be found: %v", err)
	}

	development := pushInput(member, "https://push.example.com/send/development", "laptop")
	if _, err := st.UpsertPushSubscription(ctx, development); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetPushSubscriptionDelivery(ctx, member, development.Endpoint); err != nil {
		t.Fatalf("a development registration has no session to follow: %v", err)
	}
}

func TestMarkPushSubscriptionFailureIgnoresUnknownRows(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := newTestStore(t)
	count, err := st.MarkPushSubscriptionFailure(ctx, "usr_missing", "https://push.example.com/send/none", 0)
	if err != nil || count != 0 {
		t.Fatalf("unexpected result %d: %v", count, err)
	}
}

func addPushMember(t *testing.T, st *Store, workspaceID, name, email string) string {
	t.Helper()
	user, err := st.CreateUser(context.Background(), store.CreateUserInput{DisplayName: name, Email: email})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(context.Background(), workspaceID, user.ID, store.WorkspaceRoleMember); err != nil {
		t.Fatal(err)
	}
	return user.ID
}

func enablePushover(t *testing.T, st *Store, userID, key string) {
	t.Helper()
	if _, err := st.UpdateCurrentUser(context.Background(), store.UpdateCurrentUserInput{
		UserID: userID,
		NotificationSettings: &store.NotificationSettings{
			PushoverEnabled: true,
			PushoverUserKey: key,
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func recipientsByUser(t *testing.T, st *Store, messageID string, mentioned []string) map[string]store.PushNotificationRecipient {
	t.Helper()
	recipients, err := st.ListPushNotificationRecipients(context.Background(), messageID, mentioned)
	if err != nil {
		t.Fatal(err)
	}
	out := make(map[string]store.PushNotificationRecipient, len(recipients))
	for _, recipient := range recipients {
		out[recipient.UserID] = recipient
	}
	return out
}

// pushInput builds a subscription with the RFC 8291 example client key, which
// is a real point on the curve so validation accepts it.
func pushInput(userID, endpoint, label string) store.PushSubscriptionInput {
	return store.PushSubscriptionInput{
		UserID:    userID,
		Endpoint:  endpoint,
		P256dh:    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		Auth:      "BTBZMqHH6r4Tts7J_aSIgg",
		UserAgent: label,
		// Most of these tests are about storage, not authority, so they
		// register the way the local development identity does.
		DevelopmentActor: true,
	}
}
