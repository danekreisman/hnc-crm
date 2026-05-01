-- 2026-04-30-backfill-cleaner-service-rates.sql
--
-- Backfill per-service pay rates on the cleaners table for cleaners that
-- pre-date the rate_regular_cents / rate_deep_cents / rate_moveout_cents columns.
--
-- The booking form / calcCleanerPay() already auto-picks the right rate based
-- on service type, but only if these columns are populated. Existing cleaner
-- records have NULLs here, which causes the system to fall back to hourly_rate
-- for every job — that's why deep cleans and move-outs require manual override.
--
-- Logic:
--   rate_regular_cents ← hourly_rate (default $30 if missing)
--   rate_deep_cents    ← hourly_rate + $5 (default $35)
--   rate_moveout_cents ← hourly_rate + $5 (default $35)
--
-- Only writes to NULL columns — never overwrites a value already set in the UI.
-- After running, spot-check any senior cleaners whose deep/moveout rate should
-- differ from base + $5 and adjust them in Settings → Cleaners.

-- 1. Ensure columns exist (idempotent)
alter table public.cleaners
  add column if not exists rate_regular_cents integer,
  add column if not exists rate_deep_cents integer,
  add column if not exists rate_moveout_cents integer;

-- 2. Backfill regular rate from hourly_rate
update public.cleaners
set rate_regular_cents = coalesce(hourly_rate, 30) * 100
where rate_regular_cents is null;

-- 3. Backfill deep rate at hourly_rate + $5
update public.cleaners
set rate_deep_cents = (coalesce(hourly_rate, 30) + 5) * 100
where rate_deep_cents is null;

-- 4. Backfill move-out rate at hourly_rate + $5
update public.cleaners
set rate_moveout_cents = (coalesce(hourly_rate, 30) + 5) * 100
where rate_moveout_cents is null;

-- 5. Verify
select
  name,
  hourly_rate,
  (rate_regular_cents / 100.0) as rate_regular,
  (rate_deep_cents    / 100.0) as rate_deep,
  (rate_moveout_cents / 100.0) as rate_moveout,
  status
from public.cleaners
order by status, name;
