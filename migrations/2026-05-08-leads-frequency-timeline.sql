-- 2026-05-08-leads-frequency-timeline.sql
--
-- Add frequency and timeline columns to the leads table.
--
-- Why: api/accept-call-lead.js (the VA review_call_lead accept endpoint) has
-- been trying to insert `frequency` since it was first written, but the
-- column never actually existed on the leads table. Inserts have been
-- silently failing with "Could not find the 'frequency' column of 'leads'
-- in the schema cache." The frontend uses _leadRowToDb at index.html line
-- 3249 to read `l.frequency` with a regex-from-notes fallback, which is why
-- the gap went unnoticed in the read path.
--
-- Also adding `timeline` because:
--   1. The new lead-autofill endpoint (commit 6c8081d) extracts timeline
--      from conversation history alongside the other fields
--   2. The Stage 2 SMS classifier (commit 9f8f495) extracts timeline too
--   3. It's useful structured data ("they want it Friday" vs "ASAP" vs
--      "next month") that's worth tracking separately from notes
--
-- Both columns are nullable text to match the rest of the leads table style.
-- Frequency values follow the same enum used elsewhere ("weekly", "biweekly",
-- "monthly", "one-time") but no CHECK constraint is enforced because some
-- legacy rows may have free-form text.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS frequency TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS timeline TEXT;

-- Verify (these are SELECTs - run after the ALTERs to confirm columns landed)
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'leads'
--   AND column_name IN ('frequency', 'timeline');
