package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/openclaw/clickclack/apps/api/internal/store"
	"github.com/openclaw/clickclack/apps/api/internal/store/sqlite/storedb"
)

func (s *Store) UpsertPushSubscription(ctx context.Context, input store.PushSubscriptionInput) (store.PushSubscription, error) {
	normalized, err := store.NormalizePushSubscriptionInput(input)
	if err != nil {
		return store.PushSubscription{}, err
	}
	if normalized.UserID == "" {
		return store.PushSubscription{}, errors.New("user_id is required")
	}
	sessionTokenHash := ""
	if normalized.SessionToken != "" {
		sessionTokenHash = tokenHash(normalized.SessionToken)
	}
	timestamp := now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return store.PushSubscription{}, err
	}
	defer tx.Rollback()
	qtx := s.q.WithTx(tx)
	if err := qtx.UpsertPushSubscription(ctx, storedb.UpsertPushSubscriptionParams{
		ID:               newID("psub"),
		UserID:           normalized.UserID,
		Endpoint:         normalized.Endpoint,
		P256dh:           normalized.P256dh,
		Auth:             normalized.Auth,
		UserAgent:        normalized.UserAgent,
		SessionTokenHash: sessionTokenHash,
		CreatedAt:        timestamp,
		UpdatedAt:        timestamp,
	}); err != nil {
		return store.PushSubscription{}, err
	}
	if err := qtx.TrimPushSubscriptions(ctx, storedb.TrimPushSubscriptionsParams{
		UserID:    normalized.UserID,
		KeepCount: store.MaxPushSubscriptionsPerUser,
	}); err != nil {
		return store.PushSubscription{}, err
	}
	row, err := qtx.GetPushSubscription(ctx, storedb.GetPushSubscriptionParams{
		UserID:   normalized.UserID,
		Endpoint: normalized.Endpoint,
	})
	if err != nil {
		return store.PushSubscription{}, err
	}
	if err := tx.Commit(); err != nil {
		return store.PushSubscription{}, err
	}
	return storePushSubscription(row.ID, row.UserID, row.UserAgent, row.CreatedAt, row.UpdatedAt, row.LastSuccessAt, row.FailureCount), nil
}

func (s *Store) ListPushSubscriptions(ctx context.Context, userID string) ([]store.PushSubscription, error) {
	rows, err := s.q.ListPushSubscriptions(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]store.PushSubscription, 0, len(rows))
	for _, row := range rows {
		out = append(out, storePushSubscription(row.ID, row.UserID, row.UserAgent, row.CreatedAt, row.UpdatedAt, row.LastSuccessAt, row.FailureCount))
	}
	return out, nil
}

func (s *Store) DeletePushSubscription(ctx context.Context, userID, endpoint string) error {
	return s.q.DeletePushSubscription(ctx, storedb.DeletePushSubscriptionParams{
		UserID:   userID,
		Endpoint: endpoint,
	})
}

// GetPushSubscriptionDelivery re-reads one device immediately before a
// queued push is sent. A missing row answers sql.ErrNoRows; a row whose
// session or backoff forbids sending answers the matching store error.
func (s *Store) GetPushSubscriptionDelivery(ctx context.Context, userID, endpoint string) (store.PushSubscriptionTarget, error) {
	row, err := s.q.GetPushSubscriptionDelivery(ctx, storedb.GetPushSubscriptionDeliveryParams{
		UserID:   userID,
		Endpoint: endpoint,
	})
	if err != nil {
		return store.PushSubscriptionTarget{}, err
	}
	if err := store.CheckPushDelivery(store.PushDeliveryState{
		UserID:           row.UserID,
		NextAttemptAt:    row.NextAttemptAt.String,
		SessionTokenHash: row.SessionTokenHash,
		SessionUserID:    row.SessionUserID.String,
		SessionExpiresAt: row.SessionExpiresAt.String,
		SessionRevokedAt: row.SessionRevokedAt.String,
	}, time.Now()); err != nil {
		return store.PushSubscriptionTarget{}, err
	}
	return store.PushSubscriptionTarget{
		Endpoint: row.Endpoint,
		P256dh:   row.P256dh,
		Auth:     row.Auth,
	}, nil
}

func (s *Store) MarkPushSubscriptionSuccess(ctx context.Context, userID, endpoint string) error {
	timestamp := now()
	return s.q.MarkPushSubscriptionSuccess(ctx, storedb.MarkPushSubscriptionSuccessParams{
		LastSuccessAt: sql.NullString{String: timestamp, Valid: true},
		UpdatedAt:     timestamp,
		UserID:        userID,
		Endpoint:      endpoint,
	})
}

// MarkPushSubscriptionFailure counts one failed delivery and pushes the next
// attempt out. The count is incremented in SQL so concurrent workers cannot
// lose one, and the row is never removed: only the push service reporting the
// subscription gone does that.
func (s *Store) MarkPushSubscriptionFailure(ctx context.Context, userID, endpoint string, retryAfter time.Duration) (int64, error) {
	count, err := s.q.MarkPushSubscriptionFailure(ctx, storedb.MarkPushSubscriptionFailureParams{
		UpdatedAt: now(),
		UserID:    userID,
		Endpoint:  endpoint,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	nextAttempt := time.Now().UTC().Add(store.PushRetryDelay(count, retryAfter)).Format(time.RFC3339Nano)
	return count, s.q.SetPushSubscriptionNextAttempt(ctx, storedb.SetPushSubscriptionNextAttemptParams{
		NextAttemptAt: sql.NullString{String: nextAttempt, Valid: true},
		UserID:        userID,
		Endpoint:      endpoint,
	})
}

func (s *Store) listPushSubscriptionTargets(ctx context.Context, userIDs []string) (map[string][]store.PushSubscriptionTarget, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	userIDsJSON, err := json.Marshal(userIDs)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListPushSubscriptionsForUsers(ctx, string(userIDsJSON))
	if err != nil {
		return nil, err
	}
	current := time.Now()
	targets := make(map[string][]store.PushSubscriptionTarget, len(userIDs))
	for _, row := range rows {
		if !store.PushSubscriptionReady(row.NextAttemptAt.String, row.SessionExpiresAt.String, current) {
			continue
		}
		targets[row.UserID] = append(targets[row.UserID], store.PushSubscriptionTarget{
			Endpoint: row.Endpoint,
			P256dh:   row.P256dh,
			Auth:     row.Auth,
		})
	}
	return targets, nil
}

func storePushSubscription(id, userID, userAgent, createdAt, updatedAt string, lastSuccessAt sql.NullString, failureCount int64) store.PushSubscription {
	subscription := store.PushSubscription{
		ID:           id,
		UserID:       userID,
		UserAgent:    userAgent,
		CreatedAt:    createdAt,
		UpdatedAt:    updatedAt,
		FailureCount: failureCount,
	}
	if lastSuccessAt.Valid {
		value := lastSuccessAt.String
		subscription.LastSuccessAt = &value
	}
	return subscription
}
