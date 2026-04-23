-- Track whether a review request was sent after job completion
-- Run in Supabase SQL Editor

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS review_requested_at TEXT;
-- TEXT not TIMESTAMPTZ so we can store '_skipped' suffix for skipped records

-- Also need updated_at on appointments for the cron to filter by completion time
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_appointments_review ON appointments (review_requested_at)
  WHERE status = 'completed';
