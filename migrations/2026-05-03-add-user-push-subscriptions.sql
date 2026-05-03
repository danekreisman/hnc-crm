-- Push notification subscriptions per user.
--
-- Each authenticated user (admin, VA, cleaner) can register one or more push
-- subscriptions — typically one per device they install the PWA on. When the
-- backend wants to fire a notification, it looks up all subscriptions for the
-- target user(s) and POSTs to each subscription's endpoint URL using the
-- VAPID-signed Web Push protocol.
--
-- A subscription becomes invalid when:
--   - The user uninstalls the PWA from that device
--   - The user revokes notification permission for the site
--   - The browser data is cleared
-- These show up as 410 Gone or 404 from the push endpoint, and the
-- send-push helper deletes them automatically (see api/utils/send-push.js).

CREATE TABLE IF NOT EXISTS user_push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL,        -- the push service URL (FCM/APNs proxy)
  p256dh_key   TEXT NOT NULL,        -- public key for end-to-end encryption
  auth_key     TEXT NOT NULL,        -- HMAC auth secret for the push payload
  user_agent   TEXT,                 -- "iPhone Safari", "Mac Chrome", etc — for the user's UI
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (endpoint)  -- A given push endpoint URL is unique across all users.
);

CREATE INDEX IF NOT EXISTS idx_pushsubs_user ON user_push_subscriptions (user_id);

-- RLS: users can read/insert/delete their own subscriptions. Service-role
-- key bypasses RLS, so the cron jobs and webhook can read everyone's
-- subscriptions when they need to send notifications.
ALTER TABLE user_push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can view own push subs"
  ON user_push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users can insert own push subs"
  ON user_push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users can delete own push subs"
  ON user_push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);
