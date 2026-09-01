package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/openclaw/clickclack/apps/api/internal/realtime"
	"github.com/openclaw/clickclack/apps/api/internal/store"
	sqlitestore "github.com/openclaw/clickclack/apps/api/internal/store/sqlite"
)

type reactionMutationBody struct {
	Event     store.Event             `json:"event"`
	Reactions []store.ReactionSummary `json:"reactions"`
}

func TestReactionAttributionOverHTTP(t *testing.T) {
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
	owner, err := st.EnsureBootstrap(ctx, "Owner", "attribution-http-owner@example.com")
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
	second, err := st.CreateUser(ctx, store.CreateUserInput{DisplayName: "Second", Email: "attribution-http-second@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(ctx, workspaces[0].ID, second.ID, store.WorkspaceRoleMember); err != nil {
		t.Fatal(err)
	}
	readerBot, readerToken, err := st.CreateBot(ctx, store.CreateBotInput{
		WorkspaceID: workspaces[0].ID,
		OwnerUserID: owner.ID,
		DisplayName: "Reader Bot",
		Scopes:      []string{"messages:read", "messages:write"},
		CreatedBy:   owner.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(st, realtime.NewHub(), Options{UploadDir: filepath.Join(dataDir, "uploads")}).Handler())
	t.Cleanup(server.Close)

	created := postJSONAsUser[struct {
		Message store.Message `json:"message"`
	}](t, owner.ID, server.URL+"/api/channels/"+channels[0].ID+"/messages", map[string]string{"body": "who saw this"})

	added := postJSONAsUser[reactionMutationBody](t, owner.ID, server.URL+"/api/messages/"+created.Message.ID+"/reactions", map[string]string{"emoji": "👀"})
	if len(added.Reactions) != 1 || len(added.Reactions[0].Users) != 1 || added.Reactions[0].Users[0].ID != owner.ID {
		t.Fatalf("expected the mutation response to name the reactor: %#v", added.Reactions)
	}
	if added.Reactions[0].Users[0].DisplayName != "Owner" {
		t.Fatalf("expected a hydrated display name: %#v", added.Reactions[0].Users)
	}

	postJSONAsUser[reactionMutationBody](t, second.ID, server.URL+"/api/messages/"+created.Message.ID+"/reactions", map[string]string{"emoji": "👀"})
	if _, err := st.AddReaction(ctx, store.CreateReactionInput{MessageID: created.Message.ID, UserID: readerBot.ID, Emoji: "👀"}); err != nil {
		t.Fatal(err)
	}

	// Session actor and bearer bot must see the same attribution.
	sessionView := getJSONAsUser[struct {
		Message store.Message `json:"message"`
	}](t, owner.ID, server.URL+"/api/messages/"+created.Message.ID)
	bearerView := getJSONWithBearer[struct {
		Message store.Message `json:"message"`
	}](t, readerToken.Token, server.URL+"/api/messages/"+created.Message.ID)

	for label, message := range map[string]store.Message{"session": sessionView.Message, "bearer": bearerView.Message} {
		summary := findReaction(t, message.Reactions, "👀")
		if summary.Count != 3 {
			t.Fatalf("%s: expected three reactions, got %#v", label, summary)
		}
		names := map[string]string{}
		for _, user := range summary.Users {
			names[user.ID] = user.DisplayName
		}
		if len(names) != 3 || names[owner.ID] != "Owner" || names[second.ID] != "Second" || names[readerBot.ID] != "Reader Bot" {
			t.Fatalf("%s: expected all three reactors named, got %#v", label, summary.Users)
		}
	}

	removed := deleteJSONAsUser[reactionMutationBody](t, second.ID, server.URL+"/api/messages/"+created.Message.ID+"/reactions/"+"%F0%9F%91%80")
	summary := findReaction(t, removed.Reactions, "👀")
	if summary.Count != 2 || len(summary.Users) != 2 {
		t.Fatalf("expected the removal to drop one reactor: %#v", summary)
	}
	for _, user := range summary.Users {
		if user.ID == second.ID {
			t.Fatalf("removed reactor still attributed: %#v", summary.Users)
		}
	}
}

func findReaction(t *testing.T, reactions []store.ReactionSummary, emoji string) store.ReactionSummary {
	t.Helper()
	for _, reaction := range reactions {
		if reaction.Emoji == emoji {
			return reaction
		}
	}
	t.Fatalf("no %s reaction in %#v", emoji, reactions)
	return store.ReactionSummary{}
}

func getJSONWithBearer[T any](t *testing.T, token, endpoint string) T {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET %s with bearer: %s %s", endpoint, resp.Status, string(body))
	}
	var out T
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}
