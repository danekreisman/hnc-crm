-- Migration: track when the AI follow-up was last sent for a lead.
-- Run in Supabase SQL editor.
--
-- Used by api/lead-followup-send.js to record outbound AI follow-ups.
-- Frontend can show "Last followed up: 3 days ago" on lead profiles
-- and gate the AI Follow-up button to discourage spamming the same
-- lead multiple times in a row.
--
-- Until this migration runs, the send endpoint falls back to notes-only
-- update so it doesn't break.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS last_followup_sent_at timestamptz;
