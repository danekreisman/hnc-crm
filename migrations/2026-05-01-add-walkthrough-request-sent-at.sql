-- Migration: Add walkthrough_request_sent_at to leads table.
-- Run this once in Supabase SQL editor.
--
-- Why: Janitorial leads need their own "walkthrough was requested" timestamp
-- separate from quote_sent_at. They don't get a price quote — they get a
-- walkthrough scheduling SMS+email. Storing the send time in its own column
-- keeps the data clean and lets us add walkthrough-specific automations later
-- (e.g., remind Dane to follow up if no walkthrough has been booked after N
-- days).
--
-- Until this migration runs, api/lead-capture.js falls back to stage-only
-- updates for janitorial leads, so the app works either way — but the
-- timestamp won't be recorded until the column exists.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS walkthrough_request_sent_at timestamptz;

-- Optional index if we end up querying by it (e.g., daily cron looking for
-- walkthroughs that haven't been booked).
CREATE INDEX IF NOT EXISTS idx_leads_walkthrough_request_sent_at
  ON leads (walkthrough_request_sent_at)
  WHERE walkthrough_request_sent_at IS NOT NULL;
