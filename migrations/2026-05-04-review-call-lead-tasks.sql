-- Auto-log inbound call leads (May 2026)
--
-- When OpenPhone fires `call.transcript.completed` for an inbound call from
-- an unknown number, the webhook now classifies the transcript with Claude
-- Haiku and (if it looks like a real lead inquiry) creates a task of type
-- 'review_call_lead' with an AI-extracted draft of the lead fields stored
-- in `extracted_data`. Dane reviews + edits the draft and one-taps Create.
--
-- This migration:
--   1. Adds 'review_call_lead' to the tasks_type_check constraint (otherwise
--      the webhook insert silently fails the CHECK).
--   2. Adds an `extracted_data JSONB` column on tasks to hold the AI's draft
--      so the classifier doesn't have to re-run on Accept.
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
    'project',
    'other'
  ));

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS extracted_data JSONB;
