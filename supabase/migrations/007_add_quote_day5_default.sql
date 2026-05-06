-- ─────────────────────────────────────────────────────────────────────────────
-- 007: Day-5 quote re-engagement default (Phase 2)
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds the missing equivalent of the legacy `va_task_quote_day5_enabled`
-- hardcoded job into the new stage_entered framework. Installed DISABLED
-- so it doesn't fire until Dane explicitly enables it.
--
-- When enabled, the coordination layer in `run-task-automations.js`
-- (function `isStageEnteredCovered`) will detect this row and skip the
-- legacy Day-5 job to prevent duplicate VA tasks.
--
-- 5 days × 1440 min/day = 7200 minutes.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Stage: Quoted — Day 5 re-engagement call',
  'stage_entered',
  '{"stage": "Quoted", "delay_minutes": 7200}'::jsonb,
  '[
    {
      "type": "create_va_task",
      "title": "Call {firstName} — 5-day re-engagement",
      "task_type": "call_lead_reengagement",
      "priority": "high",
      "description": "Quote was sent 5 days ago and still no booking. Surface objections and offer to schedule."
    }
  ]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;
