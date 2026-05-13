-- 2026-05-13-service-checklists-pricing-backfill.sql
--
-- Adds `pricing` field to deep + moveout service entries in the
-- settings.service_checklists override row. Without this, the override
-- masks the DEFAULTS update from commit c721c0e (api/get-checklists.js).
--
-- Safe to re-run — uses jsonb concat (||) which is upsert-by-key,
-- and matches services by `id` (not array index) so it survives reordering.

WITH pricing_text AS (
  SELECT $pricing_body$This service is billed hourly at $70 per cleaner per hour plus 4.712% GET, with a 3-hour minimum per booking. Billing is based on total cleaner-hours — for example, 2 cleaners working 3 hours equals 6 cleaner-hours of billable time.

Your quote is an estimate, not a flat fee. Your final invoice will reflect actual cleaner-hours worked.

When our crew arrives they will do a brief walkthrough to confirm the time estimate is realistic:

1. If the estimate stands or is reduced, work begins. You are billed for actual cleaner-hours worked, never exceeding the high end of your original estimate.

2. If the job is materially bigger than what was quoted, we will text you with an updated estimate. You can approve the new range, keep the original high end as a hard cap and prioritize the most important areas with us, or reschedule (trip fee may apply).

3. If you choose to cap, work stops at the cap even if not everything is finished. Priority areas you specify get done first; anything left undone can be scheduled separately at our standard hourly rate.

Your final invoice will never exceed the amount you have approved.$pricing_body$::text AS body
)
UPDATE settings
SET value = jsonb_set(
  value,
  '{services}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN s->>'id' IN ('deep', 'moveout')
          THEN s || jsonb_build_object('pricing', (SELECT body FROM pricing_text))
        ELSE s
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(value->'services') WITH ORDINALITY AS arr(s, ord)
  )
)
WHERE key = 'service_checklists';

-- Verification query — expected: deep=t, moveout=t, regular=f, airbnb=f
-- SELECT
--   svc->>'id'              AS service_id,
--   (svc->>'pricing') IS NOT NULL AS has_pricing
-- FROM settings,
--      jsonb_array_elements(value->'services') AS svc
-- WHERE key = 'service_checklists';
