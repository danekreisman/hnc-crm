-- ─────────────────────────────────────────────────────────────────────────────
-- Tide Phase 3: New Inquiry, Lost drip, Walkthrough  (2026-05-07)
-- ─────────────────────────────────────────────────────────────────────────────
-- Extends the Tide cadence with three new sets, all seeded as queue/recommendation
-- tasks (create_va_task only, no auto-send sms/email actions). All install
-- DISABLED. Dane reviews wording per row and toggles each on individually.
--
-- ── New Inquiry sequence (4 automations) ──
-- For leads that landed in 'New inquiry' stage (mostly phone-ins, referrals,
-- manual entries — form submitters typically auto-advance to Quoted on
-- submission via lead-capture's auto-quote). 5 touches across 7 days.
--
-- ── Lost drip (2 automations) ──
-- For leads sitting in 'Closed lost'. Email-only re-engagement at Day 45 and
-- Day 90. Original Tide design called for indefinite rotation, but the
-- run-automations.js cron has a 90-day lookback on lead_stage_events for
-- performance — events older than 90 days are ignored. So Day 45 and Day 90
-- are the maximum reachable touches under current infrastructure. Extending
-- the lookback to support longer cadences (e.g., Day 135, Day 180) is a
-- separate decision for later. Two touches captures most of the practical
-- value — leads who don't engage by Day 90 are deeply cold.
--
-- ── Walkthrough Day-1 confirm (1 automation) ──
-- Re-seeds a default that was originally in supabase/migrations/006 but got
-- deleted at some point. Renamed to use the Tide · prefix for consistency.
--
-- ── Idempotency ──
-- ON CONFLICT (name) DO UPDATE — safe to re-run, preserves is_enabled.
--
-- Run in Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- NEW INQUIRY SEQUENCE (5 touches across 7 days, 4 automations)
-- ═════════════════════════════════════════════════════════════════════════════

-- Day 1: call task if no response
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · New Inquiry · Day 1 call',
  'stage_entered',
  '{"stage": "New inquiry", "delay_minutes": 1440}'::jsonb,
  '[{"type":"create_va_task","title":"Call {firstName} — Day 1 inquiry follow-up","task_type":"call_lead","priority":"high","description":"Lead reached out yesterday but hasn''t gotten a quote yet (likely phone-in, referral, or manual entry). Call to find out service type, scope, and timeline. If janitorial, offer to schedule a walkthrough. If residential, get the info needed to send a quote."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 3: review-and-send SMS check-in
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · New Inquiry · Day 3 SMS',
  'stage_entered',
  '{"stage": "New inquiry", "delay_minutes": 4320}'::jsonb,
  '[{"type":"create_va_task","title":"Send SMS to {firstName} — inquiry Day 3 check-in","task_type":"other","priority":"high","description":"Suggested SMS to send via OpenPhone:\n\n\"Hey {firstName}, following up — wanted to make sure you got the info we sent over. Anything else I can help with?\"\n\nReview, edit if needed, send, then mark this task done."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 5: 2nd call task + SMS combo (two actions)
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · New Inquiry · Day 5 call + SMS',
  'stage_entered',
  '{"stage": "New inquiry", "delay_minutes": 7200}'::jsonb,
  '[{"type":"create_va_task","title":"Call {firstName} — 2nd inquiry attempt","task_type":"call_lead","priority":"high","description":"Day 5. Lead inquired but no quote sent yet — they''ve gone quiet. Try a call to figure out what they need so we can move them forward."},{"type":"create_va_task","title":"Send SMS to {firstName} — inquiry Day 5","task_type":"other","priority":"high","description":"Suggested SMS to send via OpenPhone (after call attempt):\n\n\"Hey {firstName}, tried calling — gimme a shout when you have a sec. Happy to walk through pricing or answer any questions.\"\n\nReview, edit if needed, send, then mark this task done."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 7: review-and-send final SMS
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · New Inquiry · Day 7 SMS final',
  'stage_entered',
  '{"stage": "New inquiry", "delay_minutes": 10080}'::jsonb,
  '[{"type":"create_va_task","title":"Send final SMS to {firstName} — inquiry Day 7","task_type":"other","priority":"high","description":"Suggested final SMS to send via OpenPhone:\n\n\"Hey {firstName}, last check in — still looking for cleaning help? If yes, just reply and I''ll get you sorted.\"\n\nReview, edit if needed, send, then mark this task done. If no response after this, manually move the lead to Closed lost."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;


-- ═════════════════════════════════════════════════════════════════════════════
-- LOST DRIP (Day 45 + Day 90 email re-engagement, 2 automations)
-- ═════════════════════════════════════════════════════════════════════════════

-- Day 45: gentle "thinking of you" email (45 * 1440 = 64800 minutes)
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Closed lost · Day 45 email',
  'stage_entered',
  '{"stage": "Closed lost", "delay_minutes": 64800}'::jsonb,
  '[{"type":"create_va_task","title":"Send re-engagement email to {firstName} — Day 45","task_type":"other","priority":"low","description":"Suggested email — subject: \"Checking in from Hawaii Natural Clean\".\n\nBody:\n---\nHi {firstName},\n\nIt''s been a few weeks — wanted to gently check in and see how things are going. If your cleaning needs have changed or come back up, we''d love to help.\n\nNo pressure either way. Just text us at (808) 468-5356 or reply to this email if you want to chat.\n\nMahalo,\nHawaii Natural Clean\n---\n\nReview, edit if needed, send via your email client, then mark this task done."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 90: seasonal/offer email (90 * 1440 = 129600 minutes)
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Closed lost · Day 90 email',
  'stage_entered',
  '{"stage": "Closed lost", "delay_minutes": 129600}'::jsonb,
  '[{"type":"create_va_task","title":"Send re-engagement email to {firstName} — Day 90","task_type":"other","priority":"low","description":"Suggested email — subject: \"A small offer to bring you back\".\n\nBody:\n---\nHi {firstName},\n\nIt''s been about three months. Wanted to share a small thank-you for considering us — if you''re ready to give Hawaii Natural Clean a try, we''ll take 15% off your first clean.\n\nJust reply to this email or text us at (808) 468-5356, mention this note, and we''ll get you scheduled.\n\nMahalo,\nHawaii Natural Clean\n---\n\nReview the offer (Dane: confirm 15% works for this lead before sending), edit if needed, send, then mark this task done.\n\nNote: the run-automations.js cron has a 90-day lookback on lead_stage_events. Day 90 is the latest reachable touch under current infrastructure. Leads who don''t engage by here stay in Closed lost with no further automated touches."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;


-- ═════════════════════════════════════════════════════════════════════════════
-- WALKTHROUGH DAY-1 CONFIRM (re-seed of original 006 default)
-- ═════════════════════════════════════════════════════════════════════════════

-- When a lead asks for a walkthrough, create a VA task to call and confirm
-- the walkthrough day/time the next morning.
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Walkthrough · Day 1 confirm',
  'stage_entered',
  '{"stage": "Walkthrough requested", "delay_minutes": 1440}'::jsonb,
  '[{"type":"create_va_task","title":"Confirm walkthrough with {firstName}","task_type":"call_lead","priority":"high","description":"Lead requested a walkthrough yesterday. Call to lock in date and time. After walkthrough is complete and quote sent, manually move them to Quoted (which kicks off the Tide Quoted cadence)."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;


-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run after the migration to confirm)
-- ─────────────────────────────────────────────────────────────────────────────
-- All Tide automations across all phases:
--   SELECT name, is_enabled, trigger_config->>'stage' AS stage,
--          trigger_config->>'service_type' AS service,
--          (trigger_config->>'delay_minutes')::int / 1440 AS day_offset
--     FROM lead_automations
--    WHERE name LIKE 'Tide · %'
--    ORDER BY trigger_config->>'stage', (trigger_config->>'delay_minutes')::int
--
-- After this migration: 16 (Quoted variants) + 7 (this batch) = 23 rows.
--
-- Sanity — every Tide automation should be queue-model (no auto-send):
--   SELECT name FROM lead_automations
--    WHERE name LIKE 'Tide · %'
--      AND (actions::text LIKE '%"type":"sms"%' OR actions::text LIKE '%"type":"email"%')
-- Should return ZERO rows.
