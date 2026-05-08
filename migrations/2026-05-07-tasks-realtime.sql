-- Add `tasks` table to Supabase Realtime publication.
--
-- The CRM frontend subscribes to `tasks` so the public-booking pending-review
-- banner above the calendar updates live when a customer submits a booking
-- request via book.html. Without this, a request inserted while the user is
-- sitting on the calendar wouldn't surface in the banner until the next view
-- switch or page reload.
--
-- Mirrors the 005_leads_realtime.sql pattern from May 5.
--
-- Run this in the Supabase SQL editor before the realtime banner refresh works.

ALTER TABLE tasks REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'tasks'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE tasks';
  END IF;
END $$;
