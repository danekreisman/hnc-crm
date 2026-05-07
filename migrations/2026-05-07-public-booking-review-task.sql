-- Public booking form (May 2026)
--
-- A new public-facing booking flow at /book.html (with no token) lets cold
-- leads and returning customers submit booking requests directly. Every
-- submission creates a `review_public_booking` task with all the booking
-- details in `extracted_data`. Dane reviews from the task queue and either
-- confirms (creating an actual appointment + assigning a cleaner) or
-- rejects.
--
-- This migration:
--   1. Adds 'review_public_booking' to the tasks_type_check constraint
--      (otherwise the submit endpoint silently fails the CHECK).
--
-- The `extracted_data JSONB` column already exists from the
-- 2026-05-04 review_call_lead migration, so no schema change needed there.
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
    'review_public_booking',
    'project',
    'other'
  ));
