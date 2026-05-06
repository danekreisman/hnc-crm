-- Auto-detect verbal quotes from call transcripts (May 2026)
--
-- When a call ends with a transcript that mentions a price for cleaning
-- service, Haiku extracts the amount and the webhook creates a
-- 'review_quote_sent' task. Dane confirms the amount (one tap) and the
-- system stamps quote_sent_at + quote_total + stage='Quoted' on the lead,
-- which causes the Day-1 followup task to fire the next morning.
--
-- This feature closes the gap where phone-converted leads never had
-- quote_sent_at populated, so no task automation ever fired for them.
--
-- Two paths feed this task type:
--   1. Existing-lead caller — webhook detects the quote on transcript
--      completion and creates the task directly.
--   2. New-caller `review_call_lead` flow — quote_amount is extracted in
--      the same AI pass as the lead fields, stashed in extracted_data,
--      and accept-call-lead.js creates the chained task after the lead
--      is created.
--
-- This migration:
--   1. Adds 'review_quote_sent' to the tasks_type_check constraint
--      (otherwise the webhook insert silently fails the CHECK).
--
-- The `extracted_data JSONB` column already exists on tasks (added in
-- 2026-05-04-review-call-lead-tasks.sql). It is reused here to hold
-- { amount, confidence, reasoning } so the confirm endpoint has the AI
-- draft without re-classifying.
--
-- Run this in the Supabase SQL editor before deploying the feature.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;

ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
  CHECK (type IN (
    'invoice',
    'call_lead',
    'call_client',
    'call_lead_reengagement',
    'review_lead_response',
    'review_call_lead',
    'review_quote_sent',
    'project',
    'other'
  ));
