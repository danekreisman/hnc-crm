-- Adds cleaner_name and series_index to appointments and backfills cleaner_name.
--
-- Background: same root cause as add_appointment_client_name.sql.
-- The frontend has long referenced these columns at multiple call sites
-- (populateRecurringMonth's spawn insert, dbSaveAppointment's series_index
-- conditional, the CSV import flow, etc.) but the columns never existed.
-- PostgREST silently dropped cleaner_name on some inserts and explicitly
-- errored on others. After the recent populateRecurringMonth fix started
-- writing cleaner_name unconditionally, this began surfacing as a visible
-- error when creating recurring appointments.
--
-- This script does three things in one transaction:
--   1. Adds the cleaner_name column.
--   2. Adds the series_index column.
--   3. Backfills cleaner_name for all appointments that already have a valid
--      cleaner_id, using the canonical name from cleaners.

BEGIN;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS cleaner_name TEXT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS series_index INTEGER;

-- Backfill cleaner_name where we already have cleaner_id
UPDATE appointments a
SET cleaner_name = c.name
FROM cleaners c
WHERE a.cleaner_id = c.id
  AND a.cleaner_name IS NULL;

COMMIT;
