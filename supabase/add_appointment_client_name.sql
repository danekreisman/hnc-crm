-- Adds client_name to appointments and backfills existing rows.
--
-- Background: the frontend has been writing client_name on inserts at multiple
-- call sites (dbSaveAppointment, batch builder, import flow, etc.) for a long
-- time, but the column never existed in the schema, so PostgREST silently
-- dropped the field. Result: 66 appointments with no client_id link end up
-- rendering as "Unknown" because the rendering fallback (a.client_name||'Unknown')
-- always sees an undefined client_name.
--
-- This script does three things in one transaction:
--   1. Adds the client_name column.
--   2. Backfills client_name for all appointments that already have a valid
--      client_id (~2,371 rows).
--   3. Backfills client_id + client_name for orphan appointments (no client_id)
--      by matching their address to a client.address with normalization
--      (lowercase, collapse whitespace and dashes).

BEGIN;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS client_name TEXT;

-- 1) Where client_id is set, copy the canonical name from clients.
UPDATE appointments a
SET client_name = c.name
FROM clients c
WHERE a.client_id = c.id
  AND a.client_name IS NULL;

-- 2) Orphan rows (no client_id): try to match by normalized address.
UPDATE appointments a
SET client_id = c.id, client_name = c.name
FROM clients c
WHERE a.client_id IS NULL
  AND a.address IS NOT NULL
  AND a.address <> ''
  AND c.address IS NOT NULL
  AND LOWER(REGEXP_REPLACE(a.address, '[\s\-,]+', ' ', 'g')) =
      LOWER(REGEXP_REPLACE(c.address, '[\s\-,]+', ' ', 'g'));

COMMIT;
