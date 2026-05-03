-- HNC CRM: tipping feature, phase 1 (2026-05-03)
-- Adds a single tip_amount column to appointments. For paired jobs,
-- the tip is split evenly across all assigned cleaners (1, 2, or 3)
-- at payroll-aggregation time, so we don't need per-cleaner tip columns.
--
-- Stored as a positive dollar amount (numeric). Default 0 so legacy rows
-- read as "no tip" and arithmetic in the frontend stays simple.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS tip_amount numeric NOT NULL DEFAULT 0;

-- Sanity guard: tips are non-negative.
-- Postgres doesn't support `ADD CONSTRAINT IF NOT EXISTS`, so use a DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_tip_amount_nonneg'
      AND conrelid = 'public.appointments'::regclass
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_tip_amount_nonneg CHECK (tip_amount >= 0);
  END IF;
END $$;
