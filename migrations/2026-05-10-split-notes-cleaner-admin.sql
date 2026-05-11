-- 2026-05-10 — split appointment.notes into two purpose-driven fields.
--
-- Background: a single notes column was getting filled by multiple sources
-- (customer lead form, manual booking, AI summaries) without separation
-- of audience. As a result cleaners were seeing admin context (referrals,
-- billing notes, customer personality flags) and admin views were full of
-- redundant structured data restated from other fields. Per Dane's
-- 2026-05-10 design call, split into:
--
--   cleaner_notes — operational details safe for the cleaner: parking,
--                   gate codes, pets, focus areas, allergies. This is
--                   the ONLY notes field included in cleaner SMS, cleaner
--                   portal views, and printed checklists.
--
--   admin_notes   — internal context: referral sources, billing weirdness,
--                   history, AI-generated booking summaries. Never sent
--                   to the cleaner.
--
-- The legacy `notes` column stays as-is for back-compat. Existing rows
-- keep their combined `notes` value (Dane chose not to backfill — old
-- appointments are mostly done already, not worth the AI-split risk).
-- New code reads cleaner_notes/admin_notes preferentially and falls back
-- to legacy `notes` when both new fields are empty.
--
-- Source routing for new bookings:
--   Lead form (customer typed)        → cleaner_notes
--   Manual booking, "Cleaner notes"   → cleaner_notes
--   Manual booking, "Admin notes"     → admin_notes
--   AI booking summary                → admin_notes
--
-- No defaults: NULL means "not set, fall through to legacy."

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS cleaner_notes TEXT,
  ADD COLUMN IF NOT EXISTS admin_notes   TEXT;

COMMENT ON COLUMN appointments.cleaner_notes IS 'Operational details safe to share with cleaner (parking, pets, focus areas, codes). Sent in cleaner SMS / shown in cleaner portal.';
COMMENT ON COLUMN appointments.admin_notes   IS 'Internal context for Dane only (referrals, billing notes, AI booking summaries). Never sent to cleaner.';
COMMENT ON COLUMN appointments.notes         IS 'Legacy combined notes field — preserved for historical appointments. New writes should use cleaner_notes/admin_notes instead.';
