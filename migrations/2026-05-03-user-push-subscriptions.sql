-- HNC CRM: user_push_subscriptions table (2026-05-03)
-- One row per device that has subscribed to web push notifications.
-- A single user may have multiple rows (e.g., phone + desktop).
--
-- Used by api/utils/send-push.js to fan out notifications. Populated by
-- api/register-push-subscription.js after the user grants notification
-- permission in the browser.

CREATE TABLE IF NOT EXISTS public.user_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  endpoint text NOT NULL UNIQUE,
  p256dh_key text NOT NULL,
  auth_key text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

-- Lookup by user_id (sendPushToUsers fans out to all of a user's devices)
CREATE INDEX IF NOT EXISTS user_push_subs_user_idx
  ON public.user_push_subscriptions (user_id);

-- last_used_at is updated on each successful push so admins can later see
-- which devices are actually receiving / which ones to prune.
