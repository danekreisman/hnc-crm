-- ─────────────────────────────────────────────────────────────────────────────
-- 009: AI lead recommendations + assistant role
-- ─────────────────────────────────────────────────────────────────────────────
-- Powers the assistant's "Daily list" view. Each row is an AI-generated
-- recommendation for a specific lead at a specific point in time.
--
-- Generation strategy:
--   - Cron runs twice daily (8am + 2pm HST) — `/api/run-lead-recommendations`
--   - Also recomputed on-demand when a material event fires (lead replies,
--     stage change) — `/api/refresh-lead-recommendation`
--   - Stale rows (older than 24h with no activity) get skipped on the daily
--     cron until they re-enter the priority window
--
-- Lifecycle:
--   - status='pending' when AI creates the rec, awaiting assistant action
--   - status='completed' when she clicks Send Text / Send Email / Snooze
--   - status='dismissed' when the assistant explicitly skips
--   - status='superseded' when a newer rec replaces it (we keep history)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_recommendations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- The AI's recommended action: 'call', 'text', 'email', or 'skip'.
  action_type        TEXT NOT NULL CHECK (action_type IN ('call','text','email','skip')),
  -- 1 = highest urgency, 10 = lowest. Used for ordering the daily list.
  priority           INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  -- Short reason shown to assistant (1-2 sentences max).
  reasoning          TEXT NOT NULL DEFAULT '',
  -- Suggested talking points (markdown-friendly bullet list as plain text).
  talking_points     TEXT,
  -- Pre-drafted message body for text/email. NULL for call/skip.
  draft_message      TEXT,
  -- For email only: subject line.
  draft_subject      TEXT,
  -- Lifecycle status
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','dismissed','superseded')),
  -- AI metadata for debugging
  model              TEXT,
  generation_ms      INTEGER,
  -- Audit
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  completed_by_email TEXT,
  -- Snapshot of what the action was: which channel, and whether sent.
  action_taken       JSONB
);

CREATE INDEX IF NOT EXISTS idx_lead_recs_status_pri
  ON lead_recommendations (status, priority)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_lead_recs_lead
  ON lead_recommendations (lead_id);

CREATE INDEX IF NOT EXISTS idx_lead_recs_generated
  ON lead_recommendations (generated_at DESC);

-- ── Assistant role support ──────────────────────────────────────────────
-- The existing app_users table already has a `role` column with values
-- 'admin' and 'va'. We add 'assistant' as a third role. No schema change
-- needed since `role` is TEXT — this is just a documentation marker.
-- See applyUserRole() in index.html for how the role gates UI visibility.

-- ── Assistant identity (for message signing) ────────────────────────────
-- When the AI drafts a message, it signs as the assistant who'll send it
-- (e.g., "Aloha Marii, this is Lia from Hawaii Natural Clean"). We store
-- the display name on the app_users row so the AI prompt knows who it
-- is signing as.

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS display_name TEXT;
