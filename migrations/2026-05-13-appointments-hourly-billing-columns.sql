-- 2026-05-13-appointments-hourly-billing-columns.sql
--
-- Adds hourly-billing fields to appointments for Deep Clean and Move-out
-- service types. Phase 3 of the hourly-billing transition.
--
-- All three columns are nullable so flat-rate appointments
-- (regular/airbnb/janitorial) are unaffected; their rows simply leave
-- these columns NULL and the UI keeps using the existing base_price /
-- total_price / duration_hours fields.
--
-- est_hours_low / est_hours_high (SMALLINT): cleaner-hour range presented
--   to the customer in the auto-quote SMS and on the appointment view.
--   Inherited from the lead's quote_data.range_low_hours /
--   range_high_hours when the appointment is created. Whole numbers,
--   no decimals (the SMS template uses integers).
--
-- invoice_hours_billed (NUMERIC(5,1)): actual cleaner-hours used to
--   generate the invoice. Half-hour increments (e.g. 3.5, 5.0, 7.5).
--   Set only when an invoice is generated via the appointment's invoice
--   modal. Null until then.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS est_hours_low        SMALLINT,
  ADD COLUMN IF NOT EXISTS est_hours_high       SMALLINT,
  ADD COLUMN IF NOT EXISTS invoice_hours_billed NUMERIC(5,1);

-- Verification — expected: 3 rows, est_hours_low/high SMALLINT, invoice_hours_billed NUMERIC.
-- SELECT column_name, data_type, numeric_precision, numeric_scale
-- FROM information_schema.columns
-- WHERE table_name = 'appointments'
--   AND column_name IN ('est_hours_low', 'est_hours_high', 'invoice_hours_billed')
-- ORDER BY column_name;
