-- ─────────────────────────────────────────────────────────────────────────────
-- 006: Default stage_entered automations (Phase 1.5)
-- ─────────────────────────────────────────────────────────────────────────────
-- Seeds a starter set of stage_entered automations so the Automations
-- settings page shows real, sensible defaults out of the box. ALL ARE
-- INSTALLED DISABLED (is_enabled = false) so nothing fires until Dane
-- explicitly toggles each one on. This is intentional — it lets you
-- review the wording and timing before anything goes live.
--
-- Trigger format: { "stage": "<Stage Name>", "delay_minutes": <minutes> }
--   - Day 1 = 1440 minutes
--   - Day 3 = 4320 minutes
--   - Day 30 = 43200 minutes
--
-- Idempotent — uses lead_automations_name_unique constraint (added by
-- supabase/seed_automations.sql). Safe to re-run; will not overwrite
-- is_enabled if the automation already exists, so toggling a default ON
-- and re-running this migration won't switch it back OFF.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Quoted → Day-1 VA call follow-up ──────────────────────────────────────
-- When a lead is moved to "Quoted", create a VA task tomorrow to call them
-- and answer questions / book the job. NOTE: There's an existing hardcoded
-- Day-1 task in run-task-automations.js (toggle: va_task_quote_day1_enabled).
-- This automation is in addition / parallel — disabled by default so they
-- don't double-create. When you migrate to this framework as the source of
-- truth, disable the legacy toggle in Settings → AI/VA tasks.
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Stage: Quoted — Day 1 VA call follow-up',
  'stage_entered',
  '{"stage": "Quoted", "delay_minutes": 1440}'::jsonb,
  '[
    {
      "type": "create_va_task",
      "title": "Call {firstName} — quote follow-up",
      "task_type": "call_lead",
      "priority": "high",
      "description": "Quote was sent yesterday. Call to answer questions and book the job."
    }
  ]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ── 2. Walkthrough requested → Day-1 VA confirm ──────────────────────────────
-- When a lead asks for a walkthrough, create a VA task to call and confirm
-- the walkthrough day/time the next morning.
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Stage: Walkthrough requested — Day 1 confirm task',
  'stage_entered',
  '{"stage": "Walkthrough requested", "delay_minutes": 1440}'::jsonb,
  '[
    {
      "type": "create_va_task",
      "title": "Confirm walkthrough with {firstName}",
      "task_type": "call_lead",
      "priority": "high",
      "description": "Lead requested a walkthrough. Call to lock in date and time."
    }
  ]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ── 3. Follow-up → Day-3 SMS nudge ───────────────────────────────────────────
-- When a lead is parked in "Follow-up", send a friendly SMS check-in 3 days
-- later. AI-personalized so it doesn't sound canned. Pause Phase 3 will
-- prevent this from firing if the lead replies in the meantime.
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Stage: Follow-up — Day 3 SMS nudge',
  'stage_entered',
  '{"stage": "Follow-up", "delay_minutes": 4320}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! Just checking back in on your {service} quote — happy to answer any questions or get you scheduled. Mahalo!",
      "ai_personalize": true
    }
  ]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ── 4. Closed lost → Day-30 reactivation SMS ─────────────────────────────────
-- 30 days after a lead is marked Closed lost, send a soft re-engagement SMS.
-- Respects do_not_contact via the existing automation runner check.
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Stage: Closed lost — Day 30 reactivation SMS',
  'stage_entered',
  '{"stage": "Closed lost", "delay_minutes": 43200}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! Hope you are doing well. If you are still thinking about a {service} clean, we would love to help — happy to send a fresh quote anytime. Mahalo!",
      "ai_personalize": true
    }
  ]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ── 5. Closed won → Day-1 thank-you SMS ──────────────────────────────────────
-- After a lead is booked (moved to Closed won), send a thank-you SMS the
-- next day. Reinforces the relationship before the first appointment.
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Stage: Closed won — Day 1 thank-you SMS',
  'stage_entered',
  '{"stage": "Closed won", "delay_minutes": 1440}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! Just wanted to say mahalo for booking with us — we are looking forward to the clean. Reach out anytime if anything comes up!",
      "ai_personalize": true
    }
  ]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;
