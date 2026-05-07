-- ─────────────────────────────────────────────────────────────────────────────
-- Tide Phase 5: tasks.suggested_message + tasks.suggested_channel  (2026-05-07)
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds two columns to the tasks table that let the UI render a one-tap "Send
-- SMS" button on Tide queue tasks. The task description still contains the
-- cleaner-readable framing ("Suggested SMS to send via OpenPhone:\n\n...\n\n
-- Review, edit if needed..."); the new columns hold the structured message
-- body so the UI doesn't have to regex-parse the description text.
--
-- Set by api/run-automations.js create_va_task handler when an action JSON has
-- `suggested_message` and `suggested_channel` fields. NULL on tasks that
-- weren't created by Tide (legacy day-1/day-5 follow-ups, manual tasks, etc.).
-- The UI only renders the Send button when both columns are populated AND
-- the related lead has a phone number.
--
-- IMPORTANT: this migration only adds columns. The lead_automations action
-- JSONs that need the new fields are re-seeded by re-running:
--   - migrations/2026-05-07-tide-quoted-variants.sql
--   - migrations/2026-05-07-tide-new-inquiry-lost-walkthrough.sql
-- Both use INSERT ... ON CONFLICT (name) DO UPDATE which refreshes the actions
-- field but leaves is_enabled untouched. Safe to re-run.
--
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS suggested_message TEXT,
  ADD COLUMN IF NOT EXISTS suggested_channel VARCHAR(10);

COMMENT ON COLUMN tasks.suggested_message IS 'Tide pre-drafted message body — the structured payload the UI reads to render a one-tap Send button. NULL for non-Tide tasks.';
COMMENT ON COLUMN tasks.suggested_channel IS 'sms or email — UI only renders Send button when this is set. NULL for non-Tide tasks.';

-- Verification:
--   SELECT column_name, data_type, character_maximum_length
--     FROM information_schema.columns
--    WHERE table_name = 'tasks'
--      AND column_name IN ('suggested_message', 'suggested_channel');
-- Should return both rows.
