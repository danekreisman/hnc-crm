-- 2026-05-10 — manual-send audit columns: reschedule + cleaner-notify on
-- appointments, booking-link-resent on leads.
--
-- Extends the manual-notification feature (commit e2c9f49) with three
-- more buttons:
--   - Reschedule notice on appointment modal → /api/manual-send-reschedule
--   - Send job to cleaner on appointment modal → /api/manual-send-cleaner-job
--   - Resend booking link on lead profile → /api/manual-resend-booking-link
--
-- Each new audit pair = TIMESTAMPTZ for last-sent + UUID for actor. The
-- _by columns are NULL for cron / non-manual triggers (today none of
-- the cron paths write to these specific columns, but keeping the same
-- denormalization shape for consistency).

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reschedule_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reschedule_sent_by  UUID,
  ADD COLUMN IF NOT EXISTS cleaner_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleaner_notified_by UUID;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS booking_link_resent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS booking_link_resent_by UUID;

COMMENT ON COLUMN appointments.reschedule_sent_at  IS 'Last reschedule notice (email + SMS) sent for this appointment';
COMMENT ON COLUMN appointments.reschedule_sent_by  IS 'Auth user who triggered the reschedule send (NULL for non-manual)';
COMMENT ON COLUMN appointments.cleaner_notified_at IS 'Last cleaner-job-assignment SMS sent. Set when admin pushes the job to the cleaner manually.';
COMMENT ON COLUMN appointments.cleaner_notified_by IS 'Auth user who triggered the cleaner notification';
COMMENT ON COLUMN leads.booking_link_resent_at     IS 'Last manual resend of the booking link SMS (auto-quote w/ ?bt= URL).';
COMMENT ON COLUMN leads.booking_link_resent_by     IS 'Auth user who triggered the booking-link resend';
