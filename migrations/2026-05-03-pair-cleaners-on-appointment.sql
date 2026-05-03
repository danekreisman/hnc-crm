-- Up to 3 cleaners can be paired on a single appointment ("tag team": work in
-- parallel to halve wall-clock time, each paid for their share of the hours).
-- Primary cleaner stays in appointments.cleaner_id / cleaner_pay (no migration
-- needed for existing data). Secondary + tertiary are added here as nullable
-- columns. Vast majority of jobs are solo (single cleaner) so all three
-- pairing columns are null on those rows — zero schema cost.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS cleaner_id_2 UUID REFERENCES cleaners(id),
  ADD COLUMN IF NOT EXISTS cleaner_pay_2 NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cleaner_id_3 UUID REFERENCES cleaners(id),
  ADD COLUMN IF NOT EXISTS cleaner_pay_3 NUMERIC(10,2);

-- Indices on the secondary cleaner columns so payroll/portal queries that
-- look up "appointments where cleaner X was the secondary or tertiary"
-- don't full-scan. Solo jobs leave these NULL; partial indices skip those.
CREATE INDEX IF NOT EXISTS idx_appts_cleaner_id_2 ON appointments(cleaner_id_2) WHERE cleaner_id_2 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appts_cleaner_id_3 ON appointments(cleaner_id_3) WHERE cleaner_id_3 IS NOT NULL;

-- Sanity check: cleaner_id_2 implies cleaner_id (can't have a secondary
-- without a primary). cleaner_id_3 implies cleaner_id_2. Soft-enforced via
-- this CHECK so app code can't write inconsistent state.
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_cleaner_pair_order;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_cleaner_pair_order CHECK (
    (cleaner_id_2 IS NULL OR cleaner_id IS NOT NULL) AND
    (cleaner_id_3 IS NULL OR cleaner_id_2 IS NOT NULL)
  );
