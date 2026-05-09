-- 2026-05-08-appointments-manual-discount.sql
--
-- Add manual_discount_amount and manual_discount_reason columns to appointments.
--
-- Why: index.html line 9044-9045 (saveNewAppt) and line 3059-3061 (_apptRowToDb
-- whitelist) both write these columns when Dane uses the manual-discount feature
-- on an appointment. The columns never existed in the appointments table — every
-- attempt to save an appointment with a discount has been failing with:
--   "Could not find the 'manual_discount_amount' column of 'appointments' in
--    the schema cache."
--
-- Discovered by Dane while booking Ashley. The discount feature predates this
-- migration but was never matched with a schema change.
--
-- Both columns are nullable to match how the frontend sends them — null when
-- there's no discount, populated only when Dane explicitly applies one.
--
-- manual_discount_amount: NUMERIC, dollar amount discounted off the base price
-- manual_discount_reason: TEXT, free-form note ("loyalty", "first-time", etc.)

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS manual_discount_amount NUMERIC;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS manual_discount_reason TEXT;

-- Verify after running:
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'appointments'
--   AND column_name IN ('manual_discount_amount', 'manual_discount_reason');
