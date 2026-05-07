-- ─────────────────────────────────────────────────────────────────────────────
-- Tide Phase 6: leads.tide_wake_up_date  (2026-05-07)
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a single nullable DATE column to leads, used by the Long-Term Follow-Up
-- wake-up mechanic.
--
-- Flow:
--   1. Lead asks for time ("call me back in 3 months").
--   2. Cleaner moves them to Long-Term Follow-Up stage and sets
--      tide_wake_up_date in the lead profile UI (date input + quick-pick
--      buttons +30d/+60d/+90d/+180d).
--   3. The daily run-task-automations cron checks for leads where
--      stage = 'Long-Term Follow-Up' AND tide_wake_up_date <= today, moves
--      them back to 'New inquiry' stage, and clears tide_wake_up_date.
--   4. Re-entering 'New inquiry' fires the New Inquiry Tide cadence
--      (stage_entered automations: Day 1 call, Day 3 SMS, Day 5 call+SMS,
--      Day 7 SMS final).
--
-- A partial index on the column (NULL excluded) keeps the daily cron query
-- fast as the leads table grows. Most leads will have NULL for this field.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS tide_wake_up_date DATE;

COMMENT ON COLUMN leads.tide_wake_up_date IS 'Tide Long-Term Follow-Up wake-up date — when set and the current date is on/after this, run-task-automations moves the lead to New inquiry and clears this field.';

CREATE INDEX IF NOT EXISTS idx_leads_tide_wake_up_date
  ON leads(tide_wake_up_date)
  WHERE tide_wake_up_date IS NOT NULL;

-- Verification:
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_name = 'leads' AND column_name = 'tide_wake_up_date';
-- Expect 1 row with data_type = 'date'.
