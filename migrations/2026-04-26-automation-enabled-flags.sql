-- ── Automation toggle flags ─────────────────────────────────────────────────
-- Adds boolean columns to ai_booking_settings (singleton row id=1) so each
-- automation card on the Automations view can be turned on/off independently.
--
-- IMPORTANT: All new columns DEFAULT FALSE — this is intentional. After this
-- migration deploys with the matching code, every previously-firing automation
-- will stop firing until you explicitly turn it on in the UI. This is the safe
-- default given past incidents where automations fired unintentionally to many
-- clients.
--
-- The existing reminders_enabled column is left untouched.

ALTER TABLE ai_booking_settings
  ADD COLUMN IF NOT EXISTS auto_quote_enabled              BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS janitorial_enabled              BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancel_email_enabled            BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancel_client_sms_enabled       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancel_cleaner_sms_enabled      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_sms_enabled              BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS booking_confirm_enabled         BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS va_task_quote_day1_enabled      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS va_task_quote_day5_enabled      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS va_task_post_first_clean_enabled BOOLEAN DEFAULT FALSE;
