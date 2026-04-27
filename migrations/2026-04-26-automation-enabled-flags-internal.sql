-- ── Round 3 of automation toggle flags ─────────────────────────────────────
-- Adds 6 more columns to ai_booking_settings — covering the last batch of
-- previously-invisible automations now surfaced as cards. Same fail-closed
-- posture: all DEFAULT FALSE.
--
-- 5 internal alerts (admin-facing) and 1 customer-facing (policy SMS sent
-- during first booking).
--
-- Run AFTER both prior migrations. Idempotent — safe to re-run.

ALTER TABLE ai_booking_settings
  ADD COLUMN IF NOT EXISTS new_lead_owner_email_enabled    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS new_lead_owner_sms_enabled      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_book_admin_sms_enabled     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS policy_first_booking_sms_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS task_created_email_enabled      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS task_created_sms_enabled        BOOLEAN DEFAULT FALSE;
