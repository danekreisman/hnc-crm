-- ─────────────────────────────────────────────────────────────────────────────
-- 012: Manual booking discount fields
-- ─────────────────────────────────────────────────────────────────────────────
-- Booking modal now supports a manual discount on top of the frequency
-- discount (one-off promos, friend/family, recovery from a bad clean, etc.).
--
-- Stored as the dollar amount actually deducted (not the percent), so reports
-- can sum manual_discount_amount across appointments without ambiguity.
-- The reason text is for audit/reporting — what was the discount for?
--
-- Stacking order in calcPrice:
--   base price → frequency discount → manual discount → tax → total
-- All three discounts can compound. Total never goes below 0.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS manual_discount_amount NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS manual_discount_reason TEXT;

-- Optional: index on manual_discount_amount for reporting queries that filter
-- to appointments with discounts. Skip if you never run such queries — the
-- index isn't free.
CREATE INDEX IF NOT EXISTS idx_appointments_manual_discount
  ON appointments(manual_discount_amount)
  WHERE manual_discount_amount IS NOT NULL AND manual_discount_amount > 0;
