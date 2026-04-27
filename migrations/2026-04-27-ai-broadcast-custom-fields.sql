-- ── AI Broadcast: custom content columns ───────────────────────────────────
-- Adds 6 nullable TEXT columns to the broadcasts table so AI-generated
-- broadcasts can store their full content (subject is already there).
--
-- When holiday_key = 'ai_custom', send-broadcast.js reads these fields
-- instead of looking up the static HOLIDAY_TEMPLATES dict.
--
-- All nullable — existing broadcasts (with holiday_key matching a built-in
-- template) continue to work unchanged.
--
-- Idempotent — safe to re-run.

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS custom_preheader  TEXT,
  ADD COLUMN IF NOT EXISTS custom_heading    TEXT,
  ADD COLUMN IF NOT EXISTS custom_intro      TEXT,
  ADD COLUMN IF NOT EXISTS custom_body_html  TEXT,
  ADD COLUMN IF NOT EXISTS custom_cta_text   TEXT,
  ADD COLUMN IF NOT EXISTS custom_cta_url    TEXT;
