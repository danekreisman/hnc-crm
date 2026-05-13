-- Migration: trim p5 (Quote accuracy & on-arrival adjustment) detail and
-- moveout `required` items in the settings override rows. Mirrors the
-- corresponding DEFAULTS changes in api/get-policies.js and
-- api/get-checklists.js so the user-facing waiver shows the trimmed
-- versions on the booking form Step 2.
--
-- Background: Dane's review of the booking form Step 2 (after b87c726
-- surfaced the pricing block) flagged that p5's prose was ~110 words and
-- the moveout required items had ~135 words of duplicative qualifications
-- (parentheticals, restated thresholds). Trimmed both significantly while
-- preserving every commitment a customer would care about.
--
-- Idempotent — same jsonb_set + jsonb_agg pattern as
-- 2026-05-13-service-checklists-pricing-backfill.sql. Running twice
-- produces the same end state. No-ops on rows that don't exist (the
-- WHERE filters skip them) so safe even if only one override row is
-- present.
--
-- After running, verify with:
--   SELECT s->>'id' AS id,
--          jsonb_array_length(s->'required') AS n_items,
--          LENGTH((s->'required'->>0)) AS first_item_chars
--   FROM settings, jsonb_array_elements(value->'services') AS s
--   WHERE key = 'service_checklists' AND s->>'id' = 'moveout';
--   -- Expected: n_items = 6, first_item_chars ≈ 75 (was ≈ 145)
--
--   SELECT (value::jsonb -> 'policies' -> 4 ->> 'detail') AS p5_detail
--   FROM (SELECT value::jsonb FROM settings WHERE key = 'policy_items') s;
--   -- Or, if value is stored as plain jsonb without 'policies' wrapper:
--   SELECT p->>'id' AS id, LENGTH(p->>'detail') AS chars
--   FROM settings, jsonb_array_elements(value::jsonb) AS p
--   WHERE key = 'policy_items' AND p->>'id' = 'p5';
--   -- Expected: chars ≈ 290 (was ≈ 615)

-- 1. Trim moveout `required` items in service_checklists
UPDATE settings
SET value = jsonb_set(
  value,
  '{services}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN s->>'id' = 'moveout'
        THEN jsonb_set(
          s,
          '{required}',
          jsonb_build_array(
            'Unit must be completely empty (including garage, lanai, storage, outdoor areas)',
            'All trash and debris removed before arrival — we are not a junk-haul service',
            'Fridge and freezer defrosted and emptied',
            'Water and electricity ON during cleaning',
            'Oven and stovetop operational',
            'Any active pest infestations disclosed in advance'
          )
        )
        ELSE s
      END
    )
    FROM jsonb_array_elements(value->'services') AS s
  )
)
WHERE key = 'service_checklists';

-- 2. Trim p5 detail in policy_items
-- The policy_items override stores the policies array as a JSON string in
-- the `value` column (see api/get-policies.js line 47: JSON.parse(data.value)).
-- We need to parse, update, and re-stringify. Postgres handles this via
-- the to_jsonb / jsonb_set chain; the ::text cast at the end is what
-- gets stored.
UPDATE settings
SET value = (
  SELECT jsonb_agg(
    CASE
      WHEN p->>'id' = 'p5'
      THEN jsonb_set(
        p,
        '{detail}',
        to_jsonb('If on arrival the property is materially worse than described (extra rooms, heavy soil, mold, hoarding, post-construction debris, pet damage), we will text photos and confirm a revised price before doing extra work. You can approve, cancel, or reschedule (trip fee may apply).'::text)
      )
      ELSE p
    END
  )::text
  FROM jsonb_array_elements(value::jsonb) AS p
)
WHERE key = 'policy_items';
