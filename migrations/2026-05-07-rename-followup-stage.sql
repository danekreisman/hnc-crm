-- ─────────────────────────────────────────────────────────────────────────────
-- Rename stage value: 'Follow-up' → 'Long-Term Follow-Up'  (2026-05-07)
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 of the Tide pipeline alignment.
--
-- Existing CRM uses 'Follow-up' as a generic re-engagement stage. The Tide
-- design treats this as the "lead asked for time, set a wake-up date" stage
-- specifically. Renaming to 'Long-Term Follow-Up' makes the meaning explicit
-- so Dane can manually re-curate which leads belong here vs. truly Lost or
-- still in active Quoted cadence.
--
-- This migration:
--   1. Updates leads.stage = 'Long-Term Follow-Up' for every lead currently
--      sitting in 'Follow-up'.
--   2. Updates the seeded stage_entered automation row (name + trigger_config)
--      so it continues firing for leads in the renamed stage.
--
-- It does NOT touch:
--   - lead_stage_events (historical; preserve original from_stage/to_stage)
--   - lead_automation_runs (history; references automation_id, not stage strings)
--
-- IMPORTANT: Code-level references to 'Follow-up' have all been updated in the
-- same commit (api/*.js, index.html, supabase/migrations/006). After running
-- this migration AND deploying the code, every reference to this stage in the
-- system uses the new canonical name.
--
-- Run this in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Rename the stage value on every affected lead ───────────────────────
-- The trigger on leads.stage will emit lead_stage_events rows for each row
-- updated here. That's expected and fine — the events show a transition from
-- 'Follow-up' → 'Long-Term Follow-Up' which is exactly what happened. Set a
-- session source so the events are tagged with the migration's intent.

SET LOCAL app.source = 'migration:2026-05-07-rename-followup-stage';

UPDATE leads
   SET stage = 'Long-Term Follow-Up'
 WHERE stage = 'Follow-up';

-- Sanity: log how many we touched
DO $$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM leads WHERE stage = 'Long-Term Follow-Up';
  RAISE NOTICE 'leads now in Long-Term Follow-Up: %', n;
END$$;

-- ── 2. Update the seeded automation to point at the new stage name ─────────
-- Two changes: the automation's display name (so you recognize it in the UI)
-- and trigger_config.stage (so the cron fires it for leads in the new stage).
-- Idempotent — uses the lead_automations_name_unique constraint via the old
-- name, so re-running this is a no-op if the rename has already happened.

UPDATE lead_automations
   SET name = 'Stage: Long-Term Follow-Up — Day 3 SMS nudge',
       trigger_config = jsonb_set(trigger_config, '{stage}', '"Long-Term Follow-Up"')
 WHERE name = 'Stage: Follow-up — Day 3 SMS nudge'
    OR (trigger_type = 'stage_entered' AND trigger_config->>'stage' = 'Follow-up');

-- Catch any other stage_entered automations that might reference the old name
-- (defensive — covers the case where Dane added custom ones we don't know
-- about). Leaves the name alone, only updates trigger_config.
UPDATE lead_automations
   SET trigger_config = jsonb_set(trigger_config, '{stage}', '"Long-Term Follow-Up"')
 WHERE trigger_type = 'stage_entered'
   AND trigger_config->>'stage' = 'Follow-up';

-- ── 3. Verification queries (run these after commit to confirm) ─────────────
-- SELECT stage, COUNT(*) FROM leads GROUP BY stage ORDER BY 1;
-- SELECT name, trigger_config FROM lead_automations WHERE trigger_type = 'stage_entered';
-- SELECT from_stage, to_stage, source, occurred_at FROM lead_stage_events
--   WHERE source = 'migration:2026-05-07-rename-followup-stage' ORDER BY occurred_at DESC LIMIT 5;

COMMIT;
