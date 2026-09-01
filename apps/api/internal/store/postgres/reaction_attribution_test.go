package postgres

import (
	"context"
	"fmt"
	"testing"

	"github.com/openclaw/clickclack/apps/api/internal/store"
)

func TestMessagePageAttributesReactions(t *testing.T) {
	ctx := context.Background()
	st := newIsolatedPostgresTestStore(t)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := st.EnsureBootstrap(ctx, "Attribution Owner", "postgres-attribution-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	workspaces, err := st.ListWorkspaces(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	member, err := st.CreateUser(ctx, store.CreateUserInput{DisplayName: "Attribution Member", Email: "postgres-attribution-member@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(ctx, workspaces[0].ID, member.ID, store.WorkspaceRoleMember); err != nil {
		t.Fatal(err)
	}
	bot, _, err := st.CreateBot(ctx, store.CreateBotInput{
		WorkspaceID: workspaces[0].ID,
		OwnerUserID: owner.ID,
		DisplayName: "Attribution Bot",
		Scopes:      []string{"messages:read"},
		CreatedBy:   owner.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	channels, err := st.ListChannels(ctx, workspaces[0].ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	message, _, err := st.CreateMessage(ctx, store.CreateMessageInput{ChannelID: channels[0].ID, AuthorID: owner.ID, Body: "attribute me", Nonce: "attribution-1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, reactor := range []string{owner.ID, member.ID, bot.ID} {
		if _, err := st.AddReaction(ctx, store.CreateReactionInput{MessageID: message.ID, UserID: reactor, Emoji: "👀"}); err != nil {
			t.Fatal(err)
		}
	}

	page, err := st.ListMessages(ctx, channels[0].ID, owner.ID, store.MessagePageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	summary := reactionSummary(page.Messages[len(page.Messages)-1].Reactions, "👀")
	if summary.Count != 3 || !summary.ReactedByMe {
		t.Fatalf("unexpected summary: %#v", summary)
	}
	if len(summary.Users) != 3 {
		t.Fatalf("expected three named reactors, got %#v", summary.Users)
	}
	// Bots are users: a bot reactor is named like anyone else.
	byID := map[string]store.ReactionUser{}
	for _, user := range summary.Users {
		byID[user.ID] = user
	}
	if got := byID[bot.ID]; got.DisplayName != "Attribution Bot" {
		t.Fatalf("expected the bot named among reactors, got %#v", summary.Users)
	}
	if got := byID[member.ID]; got.DisplayName != "Attribution Member" {
		t.Fatalf("expected the member named among reactors, got %#v", summary.Users)
	}

	if _, err := st.RemoveReaction(ctx, store.CreateReactionInput{MessageID: message.ID, UserID: member.ID, Emoji: "👀"}); err != nil {
		t.Fatal(err)
	}
	after, err := st.GetMessage(ctx, message.ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	summary = reactionSummary(after.Reactions, "👀")
	if summary.Count != 2 || len(summary.Users) != 2 {
		t.Fatalf("expected the removed reactor to drop out, got %#v", summary)
	}
	for _, user := range summary.Users {
		if user.ID == member.ID {
			t.Fatalf("removed reactor still attributed: %#v", summary.Users)
		}
	}
}

func TestReactionAttributionStaysBounded(t *testing.T) {
	ctx := context.Background()
	st := newIsolatedPostgresTestStore(t)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := st.EnsureBootstrap(ctx, "Bounded Owner", "postgres-bounded-owner@example.com")
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
	message, _, err := st.CreateMessage(ctx, store.CreateMessageInput{ChannelID: channels[0].ID, AuthorID: owner.ID, Body: "pile on", Nonce: "bounded-1"})
	if err != nil {
		t.Fatal(err)
	}

	total := store.ReactionUserLimit + 4
	for i := range total {
		reactor, err := st.CreateUser(ctx, store.CreateUserInput{
			DisplayName: fmt.Sprintf("Reactor %02d", i),
			Email:       fmt.Sprintf("postgres-bounded-reactor-%02d@example.com", i),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := st.AddWorkspaceMember(ctx, workspaces[0].ID, reactor.ID, store.WorkspaceRoleMember); err != nil {
			t.Fatal(err)
		}
		if _, err := st.AddReaction(ctx, store.CreateReactionInput{MessageID: message.ID, UserID: reactor.ID, Emoji: "🔥"}); err != nil {
			t.Fatal(err)
		}
	}

	loaded, err := st.GetMessage(ctx, message.ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	summary := reactionSummary(loaded.Reactions, "🔥")
	if summary.Count != int64(total) {
		t.Fatalf("expected the count to stay authoritative, got %#v", summary)
	}
	if len(summary.Users) != store.ReactionUserLimit {
		t.Fatalf("expected attribution capped at %d, got %d", store.ReactionUserLimit, len(summary.Users))
	}
	for _, user := range summary.Users {
		if user.DisplayName == "" || user.ID == "" {
			t.Fatalf("expected hydrated reactor identities, got %#v", summary.Users)
		}
	}
}
