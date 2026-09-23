ALTER TABLE user_push_subscriptions ADD COLUMN vapid_key_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_push_subscriptions ADD COLUMN failing_since TEXT;
