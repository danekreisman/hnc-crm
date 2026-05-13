-- Migration: trim the `pricing` field on the deep + moveout services in the
-- settings.service_checklists override row from the original ~250-word prose
-- (commit 7bff591) down to ~70 words.
--
-- Background: the original prose included a 3-outcome walkthrough breakdown
-- that was too heavy for a customer-facing consent surface (booking form
-- Step 2 banner, ref commit b87c726). Trimmed version keeps the core
-- disclosure: rate, GET, 3-hour minimum, cleaner-hours definition with
-- worked example, and the cap-protection guarantee. Walkthrough flow now
-- summarized as a single sentence.
--
-- Pattern: the same jsonb_set + jsonb_agg matched-by-id approach as
-- 2026-05-13-service-checklists-pricing-backfill.sql. Idempotent — running
-- it twice produces the same end state. Only touches the `pricing` field
-- on services whose id is 'deep' or 'moveout'.
--
-- After running this, verify with:
--   SELECT s->>'id' AS id,
--          LEFT(s->>'pricing', 60) AS preview,
--          LENGTH(s->>'pricing') AS chars
--   FROM settings,
--        jsonb_array_elements(value->'services') AS s
--   WHERE key = 'service_checklists' AND s->>'id' IN ('deep','moveout');
-- Expected: deep + moveout both show ~440-460 chars (down from ~1126).

UPDATE settings
SET value = jsonb_set(
  value,
  '{services}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN s->>'id' IN ('deep','moveout')
        THEN jsonb_set(
          s,
          '{pricing}',
          to_jsonb('Billed hourly at $70/cleaner-hour, plus 4.712% Hawaii GET, with a 3-hour minimum.

Cleaner-hours = number of cleaners × hours worked (e.g., 2 cleaners × 3 hours = 6 cleaner-hours).

Your quote is an estimate, not a flat fee. If conditions are materially bigger than quoted, we will text you with options before exceeding the high end. Your final invoice never exceeds an amount you have approved.'::text)
        )
        ELSE s
      END
    )
    FROM jsonb_array_elements(value->'services') AS s
  )
)
WHERE key = 'service_checklists';
