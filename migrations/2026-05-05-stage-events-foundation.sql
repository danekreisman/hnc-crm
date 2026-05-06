-- Stage Events Foundation (2026-05-05)
--
-- Phase 1 of the automation framework refactor described in the May 5 session.
-- Adds an event-driven primitive: every change to leads.stage emits a row into
-- lead_stage_events. The run-automations cron polls this table and fires
-- automations whose trigger_type='stage_entered' matches the event's to_stage
-- value, respecting the configured delay_minutes.
--
-- This phase ONLY lays the rail. It does NOT migrate any existing hardcoded
-- stage-driven behavior (Day-1 VA call, lead-capture's auto-quote, etc.).
-- Those move into stage_entered automations as later phases.
--
-- Architecture choice (see DEVELOPMENT_GUIDE for full rationale):
--   - DB trigger emits events. Application code keeps writing stage with
--     plain UPDATEs — no central helper required. The trigger guarantees
--     no event is ever dropped.
--   - Optional session-variable enrichment: app code can SET LOCAL
--     app.actor_user_id / app.source / app.notes / app.triggered_by_automation_id
--     before an UPDATE and the trigger picks them up. Lazy adoption — call
--     sites can enrich over time without breaking anything.
--
-- Run in Supabase SQL editor.

-- ── 1. Events table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_stage_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                  UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage               TEXT,                          -- NULL on INSERT events
  to_stage                 TEXT NOT NULL,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at             TIMESTAMPTZ,                   -- nullable; fully-processed marker (set when no automations remain to fire)
  source                   TEXT,                          -- e.g. 'app:lead-capture', 'cron:stage-advance', 'manual:supabase'
  actor_user_id            UUID,                          -- nullable; populated when caller sets app.actor_user_id session var
  triggered_by_automation_id UUID,                        -- nullable; if this stage move was caused by another automation, which one
  notes                    TEXT                           -- nullable; free-form annotation set via app.notes session var
);

-- Fast lookup of unprocessed events by stage (the run-automations cron's hot query).
CREATE INDEX IF NOT EXISTS idx_lead_stage_events_to_stage_occurred
  ON lead_stage_events(to_stage, occurred_at)
  WHERE processed_at IS NULL;

-- Fast lookup of events for a specific lead (used by debug UI / lead profile timeline).
CREATE INDEX IF NOT EXISTS idx_lead_stage_events_lead_id
  ON lead_stage_events(lead_id, occurred_at DESC);

-- ── 2. Per-automation idempotency on lead_automation_runs ──────────────────
--
-- For stage_entered triggers, idempotency is per (automation_id, stage_event_id)
-- pair — NOT per (automation_id, lead_id) like the other triggers, because a
-- single lead can legitimately re-enter the same stage and re-trigger the
-- automation. Each entry produces a distinct stage_event_id.
--
-- Existing rows have stage_event_id NULL (they came from non-stage_entered
-- triggers). The new column doesn't break the legacy idempotency check.

ALTER TABLE lead_automation_runs
  ADD COLUMN IF NOT EXISTS stage_event_id UUID REFERENCES lead_stage_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lead_automation_runs_stage_event
  ON lead_automation_runs(stage_event_id, automation_id)
  WHERE stage_event_id IS NOT NULL;

-- ── 3. Trigger functions ───────────────────────────────────────────────────
--
-- Both functions are defensive:
--   - Only insert when stage actually changed (UPDATE) or stage is non-null (INSERT)
--   - Read optional session vars with current_setting(..., true) — the `true`
--     suppresses the error when the var isn't set, returning NULL instead
--   - Wrap in BEGIN/EXCEPTION so a malformed session var (e.g. invalid UUID
--     for actor_user_id) doesn't break the underlying UPDATE/INSERT

CREATE OR REPLACE FUNCTION emit_stage_event_on_update() RETURNS TRIGGER AS $$
DECLARE
  v_actor UUID;
  v_triggered_by UUID;
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    -- Best-effort UUID parse; fall through to NULL on bad input.
    BEGIN v_actor := current_setting('app.actor_user_id', true)::UUID;
    EXCEPTION WHEN OTHERS THEN v_actor := NULL; END;
    BEGIN v_triggered_by := current_setting('app.triggered_by_automation_id', true)::UUID;
    EXCEPTION WHEN OTHERS THEN v_triggered_by := NULL; END;

    INSERT INTO lead_stage_events (lead_id, from_stage, to_stage, source, actor_user_id, triggered_by_automation_id, notes)
    VALUES (
      NEW.id,
      OLD.stage,
      NEW.stage,
      NULLIF(current_setting('app.source', true), ''),
      v_actor,
      v_triggered_by,
      NULLIF(current_setting('app.notes', true), '')
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION emit_stage_event_on_insert() RETURNS TRIGGER AS $$
DECLARE
  v_actor UUID;
  v_triggered_by UUID;
BEGIN
  IF NEW.stage IS NOT NULL AND NEW.stage <> '' THEN
    BEGIN v_actor := current_setting('app.actor_user_id', true)::UUID;
    EXCEPTION WHEN OTHERS THEN v_actor := NULL; END;
    BEGIN v_triggered_by := current_setting('app.triggered_by_automation_id', true)::UUID;
    EXCEPTION WHEN OTHERS THEN v_triggered_by := NULL; END;

    INSERT INTO lead_stage_events (lead_id, from_stage, to_stage, source, actor_user_id, triggered_by_automation_id, notes)
    VALUES (
      NEW.id,
      NULL,
      NEW.stage,
      NULLIF(current_setting('app.source', true), ''),
      v_actor,
      v_triggered_by,
      NULLIF(current_setting('app.notes', true), '')
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 4. Triggers ────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS lead_stage_change_trigger ON leads;
CREATE TRIGGER lead_stage_change_trigger
  AFTER UPDATE OF stage ON leads
  FOR EACH ROW
  EXECUTE FUNCTION emit_stage_event_on_update();

DROP TRIGGER IF EXISTS lead_stage_insert_trigger ON leads;
CREATE TRIGGER lead_stage_insert_trigger
  AFTER INSERT ON leads
  FOR EACH ROW
  EXECUTE FUNCTION emit_stage_event_on_insert();

-- ── 5. Sanity check (informational) ────────────────────────────────────────
-- After running this migration, you can verify the plumbing by:
--   1. UPDATE leads SET stage = 'Quoted' WHERE id = '<some-lead-id>';
--   2. SELECT * FROM lead_stage_events ORDER BY occurred_at DESC LIMIT 5;
--   3. The event row should appear with from_stage = the previous value,
--      to_stage = 'Quoted', occurred_at ≈ now(), processed_at = NULL.
