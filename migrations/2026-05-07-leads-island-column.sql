-- Add `island` column to the leads table.
--
-- Until now island has only been stored in the freeform `notes` text field,
-- which means you can't filter or aggregate leads by island. With this column
-- you can query "what % of new leads are Maui" or filter the pipeline by
-- island. Backfill from the notes column is included.
--
-- The column is nullable since we don't always know an island (mainland
-- bookings, leads imported before this column existed, etc).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS island TEXT;

-- Backfill: parse "Island: <value>" from notes for existing rows
UPDATE leads
SET island = TRIM(SUBSTRING(notes FROM 'Island:\s*([^\n]+)'))
WHERE island IS NULL
  AND notes IS NOT NULL
  AND notes ~ 'Island:\s*\S';

-- Optional: index for quick island-based filtering. Cheap on a small table.
CREATE INDEX IF NOT EXISTS leads_island_idx ON leads (island) WHERE island IS NOT NULL;
