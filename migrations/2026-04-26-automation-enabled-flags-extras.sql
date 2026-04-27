-- ── Additional automation toggle flags ──────────────────────────────────────
-- Extension to the original automation flags migration. Adds 5 more columns
-- for previously-invisible automations now surfaced as cards in the
-- Automations view. All DEFAULT FALSE — same fail-closed posture.
--
-- Run AFTER the first migration (2026-04-26-automation-enabled-flags.sql).
-- Idempotent — safe to re-run.

ALTER TABLE ai_booking_settings
  ADD COLUMN IF NOT EXISTS reschedule_email_enabled        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reschedule_cleaner_sms_enabled  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS post_clean_thankyou_enabled     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS invoice_reminder_enabled        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS policy_reminder_enabled         BOOLEAN DEFAULT FALSE;
