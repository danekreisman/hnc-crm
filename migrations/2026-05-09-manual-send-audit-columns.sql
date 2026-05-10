-- 2026-05-09 — manual notification audit columns on appointments.
--
-- Supports the "manual send" buttons in the appointment modal: the
-- admin can trigger a confirmation email, a day-before-style reminder
-- SMS, or a service-policy waiver SMS on demand for a single
-- appointment, and we track when each was last sent and who sent it.
--
-- Each action gets two columns: a TIMESTAMPTZ for the last-sent moment
-- and a UUID for the auth user who triggered it. A NULL timestamp
-- means "never sent manually" — the cron-based day-before reminder
-- does not write to reminder_sent_at (to keep manual-vs-auto audits
-- clean; if we later want a single combined column we can merge).
--
-- The matching `_xxxRowToDbEntry` helper (apptData) does NOT need to
-- read these columns — they're set server-side by the manual-send
-- endpoints only. The UI reads them via the existing appointments
-- select that loads the modal.
--
-- Run this in the Supabase SQL editor BEFORE deploying the code that
-- references these columns. The schema-enforcement script
-- (scripts/check-schema.js) will fail the build if the snapshot has
-- columns that aren't in the live DB.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_sent_by UUID,
  ADD COLUMN IF NOT EXISTS reminder_sent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_sent_by     UUID,
  ADD COLUMN IF NOT EXISTS waiver_sent_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waiver_sent_by       UUID;

-- No index needed — these columns are per-row reads from the
-- appointment modal, never queried in aggregate.

COMMENT ON COLUMN appointments.confirmation_sent_at IS 'Last manual confirmation email send (UTC)';
COMMENT ON COLUMN appointments.confirmation_sent_by IS 'Auth user id who triggered the manual confirmation';
COMMENT ON COLUMN appointments.reminder_sent_at     IS 'Last manual day-before-style reminder send (UTC). Cron reminders do not write here.';
COMMENT ON COLUMN appointments.reminder_sent_by     IS 'Auth user id who triggered the manual reminder';
COMMENT ON COLUMN appointments.waiver_sent_at       IS 'Last manual waiver/policy-agreement SMS send (UTC)';
COMMENT ON COLUMN appointments.waiver_sent_by       IS 'Auth user id who triggered the manual waiver SMS';
