package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/openclaw/clickclack/apps/api/internal/store"
	"github.com/openclaw/clickclack/apps/api/internal/store/sqlite/storedb"
)

func (s *Store) GetSidebarPreferences(ctx context.Context, userID string) (*store.SidebarPreferences, error) {
	rows, err := s.q.ListSidebarChannelOrder(ctx, userID)
	if err != nil {
		return nil, err
	}
	order := make(map[string][]string, len(rows))
	for _, row := range rows {
		ids, err := decodeSidebarChannelOrder(row.ChannelIds)
		if err != nil {
			// A row we cannot read is a stale cache, not a broken account. The
			// workspace falls back to the server's default ordering.
			continue
		}
		if len(ids) == 0 {
			continue
		}
		order[row.WorkspaceID] = ids
	}
	if len(order) == 0 {
		return nil, nil
	}
	return &store.SidebarPreferences{ChannelOrder: order}, nil
}

func updateSidebarPreferences(ctx context.Context, q *storedb.Queries, userID string, patch store.SidebarPreferencesPatch, timestamp string) error {
	for workspaceID, order := range patch.ChannelOrder {
		if _, err := q.RequireMembership(ctx, storedb.RequireMembershipParams{WorkspaceID: workspaceID, UserID: userID}); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return store.ErrNotWorkspaceMember
			}
			return err
		}
		channelIDs, err := q.ListWorkspaceChannelIDs(ctx, workspaceID)
		if err != nil {
			return err
		}
		filtered := store.FilterSidebarChannelOrder(order, channelIDs)
		if len(filtered) == 0 {
			if err := q.DeleteSidebarChannelOrder(ctx, storedb.DeleteSidebarChannelOrderParams{
				UserID:      userID,
				WorkspaceID: workspaceID,
			}); err != nil {
				return err
			}
			continue
		}
		encoded, err := json.Marshal(filtered)
		if err != nil {
			return err
		}
		if err := q.UpsertSidebarChannelOrder(ctx, storedb.UpsertSidebarChannelOrderParams{
			UserID:      userID,
			WorkspaceID: workspaceID,
			ChannelIds:  string(encoded),
			UpdatedAt:   timestamp,
		}); err != nil {
			return err
		}
	}
	return nil
}

func decodeSidebarChannelOrder(raw string) ([]string, error) {
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return nil, err
	}
	return ids, nil
}
