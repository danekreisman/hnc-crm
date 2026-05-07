-- ─────────────────────────────────────────────────────────────────────────────
-- Tide Phase 2: seed Quoted-stage cadence variants  (2026-05-07, rewritten)
-- ─────────────────────────────────────────────────────────────────────────────
-- Three service-type-branched cadences for the Quoted stage, designed in the
-- May 2026 Tide brainstorm:
--
--   • Move-Out  (deadline-driven, 7-day window)  — 4 automations
--   • Deep Clean  (event-driven, 10-day window)  — 6 automations
--   • Regular  (lifestyle decision, 14-day window) — 6 automations
--
-- ALL INSTALL DISABLED. Dane reviews wording per-automation and toggles each
-- on individually before any change in behavior.
--
-- ── QUEUE MODEL, NOT AUTO-SEND ──
-- Every action in this file uses `create_va_task` — i.e., the automation
-- DROPS A RECOMMENDATION TASK, it does NOT auto-fire SMS or email. Each
-- task description includes the pre-drafted message body. Cleaner reads,
-- edits if needed, sends manually via OpenPhone, then marks the task done.
-- This is intentional and matches the Tide design ("nothing leaves the
-- system without a human glance"). The proper one-tap-send UI on top of
-- these tasks is a Phase 3 deliverable.
--
-- Initial draft of this migration used `sms` and `email` action types
-- which DO auto-fire via /api/send-sms and /api/send-email. Caught and
-- corrected before any automation was enabled.
--
-- ── Service-type filter requirement ──
-- These rows depend on the `service_type` field in trigger_config being
-- honored by the stage_entered handler. The handler change in
-- api/run-automations.js (commit 5969ca6) added that filter PLUS a
-- current-stage gate. Without that code, this migration would still
-- INSERT cleanly but every variant would fire for every Quoted lead
-- regardless of service.
--
-- ── Service value canon ──
-- Values match the lead-form.html radio inputs verbatim:
--   • "Move-out Cleaning"
--   • "Deep Cleaning"
--   • "Regular Cleaning"
-- (Other svc values: "Airbnb Turnover" / "Janitorial Cleaning" are intentionally
-- NOT covered by these variants. Janitorial uses the Walkthrough flow. Airbnb
-- defaults to no automation in v1, treat manually for now.)
--
-- ── Idempotency ──
-- ON CONFLICT (name) DO UPDATE — re-running this migration will refresh
-- trigger_config and actions but will NOT toggle is_enabled back to false
-- if Dane has already turned an automation on. Safe to re-run.
--
-- Day → minute reference: Day 1 = 1440  ·  Day 2 = 2880  ·  Day 3 = 4320
-- Day 4 = 5760  ·  Day 5 = 7200  ·  Day 6 = 8640  ·  Day 7 = 10080
-- Day 8 = 11520  ·  Day 10 = 14400  ·  Day 11 = 15840  ·  Day 14 = 20160
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- MOVE-OUT VARIANT (7-day window, 5 touches across 4 automations)
-- ═════════════════════════════════════════════════════════════════════════════

-- Day 1: call task — urgent framing
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Move-Out · Day 1 call',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Move-out Cleaning", "delay_minutes": 1440}'::jsonb,
  '[{"type":"create_va_task","title":"Call {firstName} — move-out quote follow-up","task_type":"call_lead","priority":"high","description":"Move-out quote was sent yesterday. Hard deadline. Call to confirm quote receipt, answer questions, and push for booking. Emphasize that capacity for their date is filling fast."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 2: review-and-send SMS task
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Move-Out · Day 2 SMS',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Move-out Cleaning", "delay_minutes": 2880}'::jsonb,
  '[{"type":"create_va_task","title":"Send SMS to {firstName} — move-out Day 2 check-in","task_type":"other","priority":"high","description":"Suggested SMS to send via OpenPhone:\n\n\"Hey {firstName}, just following up on the move-out clean quote — happy to answer any questions or lock in your date whenever you''re ready.\"\n\nReview, edit if needed, send, then mark this task done.","suggested_message":"Hey {firstName}, just following up on the move-out clean quote — happy to answer any questions or lock in your date whenever you''re ready.","suggested_channel":"sms"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 4: SMS task + call task (two separate review tasks in one automation)
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Move-Out · Day 4 SMS + call',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Move-out Cleaning", "delay_minutes": 5760}'::jsonb,
  '[{"type":"create_va_task","title":"Send SMS to {firstName} — move-out Day 4 check-in","task_type":"other","priority":"high","description":"Suggested SMS to send via OpenPhone:\n\n\"Hi {firstName} — wanted to make sure the move-out quote came through. Want me to hold the date for you?\"\n\nReview, edit if needed, send, then mark this task done.","suggested_message":"Hi {firstName} — wanted to make sure the move-out quote came through. Want me to hold the date for you?","suggested_channel":"sms"},{"type":"create_va_task","title":"Call {firstName} — 2nd move-out attempt","task_type":"call_lead","priority":"high","description":"Day 4. Quote sent, no booking. Move-out is deadline-driven — friendly but firmer push toward decision. If voicemail, leave a clear message about capacity."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 6: review-and-send final SMS
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Move-Out · Day 6 SMS final',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Move-out Cleaning", "delay_minutes": 8640}'::jsonb,
  '[{"type":"create_va_task","title":"Send final SMS to {firstName} — move-out Day 6","task_type":"other","priority":"high","description":"Suggested final SMS to send via OpenPhone:\n\n\"Hey {firstName}, last check before we close this out — still want us to handle the move-out clean? Just say the word and we''ll get you on the schedule.\"\n\nReview, edit if needed, send, then mark this task done. If no response after this, manually move the lead to Closed lost.","suggested_message":"Hey {firstName}, last check before we close this out — still want us to handle the move-out clean? Just say the word and we''ll get you on the schedule.","suggested_channel":"sms"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;


-- ═════════════════════════════════════════════════════════════════════════════
-- DEEP CLEAN VARIANT (10-day window, 6-7 touches across 6 automations)
-- ═════════════════════════════════════════════════════════════════════════════

-- Day 1: call task
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Deep Clean · Day 1 call',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Deep Cleaning", "delay_minutes": 1440}'::jsonb,
  '[{"type":"create_va_task","title":"Call {firstName} — deep clean quote follow-up","task_type":"call_lead","priority":"high","description":"Deep clean quote was sent yesterday. Call to confirm receipt, answer questions, push for booking."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 2: review-and-send SMS task
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Deep Clean · Day 2 SMS',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Deep Cleaning", "delay_minutes": 2880}'::jsonb,
  '[{"type":"create_va_task","title":"Send SMS to {firstName} — deep clean Day 2 check-in","task_type":"other","priority":"medium","description":"Suggested SMS to send via OpenPhone:\n\n\"Hey {firstName}, just following up on the deep clean quote — let me know if any questions came up.\"\n\nReview, edit if needed, send, then mark this task done.","suggested_message":"Hey {firstName}, just following up on the deep clean quote — let me know if any questions came up.","suggested_channel":"sms"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 4: SMS task + email task (two separate review tasks)
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Deep Clean · Day 4 SMS + email',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Deep Cleaning", "delay_minutes": 5760}'::jsonb,
  '[{"type":"create_va_task","title":"Send SMS to {firstName} — deep clean Day 4 check-in","task_type":"other","priority":"medium","description":"Suggested SMS to send via OpenPhone:\n\n\"Hi {firstName}, did the quote work for you? Happy to walk through what''s included if helpful.\"\n\nReview, edit if needed, send, then mark this task done.","suggested_message":"Hi {firstName}, did the quote work for you? Happy to walk through what''s included if helpful.","suggested_channel":"sms"},{"type":"create_va_task","title":"Send email to {firstName} — what''s in a deep clean","task_type":"other","priority":"medium","description":"Suggested email — subject: \"What''s included in your deep clean\".\n\nBody:\n---\nHi {firstName},\n\nWanted to follow up on the deep clean quote we sent. Quick rundown of what a deep clean covers with us:\n\n- Inside fridge, oven, and microwave\n- Baseboards, vents, and ceiling fans\n- Cabinet exteriors and door tops\n- Detailed bathroom (grout, fixtures, behind toilet)\n- Window sills and tracks\n\nTakes us about twice as long as a regular clean — and the difference is night and day. If you have any questions or want to lock in a date, just reply or text us at (808) 468-5356.\n\nMahalo,\nHawaii Natural Clean\n---\n\nReview, edit if needed, send via your email client (or Gmail), then mark this task done.","suggested_message":"Hi {firstName},\n\nWanted to follow up on the deep clean quote we sent. Quick rundown of what a deep clean covers with us:\n\n- Inside fridge, oven, and microwave\n- Baseboards, vents, and ceiling fans\n- Cabinet exteriors and door tops\n- Detailed bathroom (grout, fixtures, behind toilet)\n- Window sills and tracks\n\nTakes us about twice as long as a regular clean — and the difference is night and day. If you have any questions or want to lock in a date, just reply or text us at (808) 468-5356.\n\nMahalo,\nHawaii Natural Clean","suggested_channel":"email"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 6: review-and-send SMS check-in
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Deep Clean · Day 6 SMS',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Deep Cleaning", "delay_minutes": 8640}'::jsonb,
  '[{"type":"create_va_task","title":"Send SMS to {firstName} — deep clean Day 6 check-in","task_type":"other","priority":"medium","description":"Suggested SMS to send via OpenPhone:\n\n\"Hey {firstName} — checking in. We''ve got availability the next couple weeks, want me to slot you in?\"\n\nReview, edit if needed, send, then mark this task done.","suggested_message":"Hey {firstName} — checking in. We''ve got availability the next couple weeks, want me to slot you in?","suggested_channel":"sms"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 8: 2nd call task
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Deep Clean · Day 8 call',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Deep Cleaning", "delay_minutes": 11520}'::jsonb,
  '[{"type":"create_va_task","title":"Call {firstName} — 2nd deep clean attempt","task_type":"call_lead","priority":"medium","description":"Day 8. Quote''s been sitting for over a week. Reinforce value, address any objections, propose a specific date."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 10: review-and-send final SMS
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Deep Clean · Day 10 SMS final',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Deep Cleaning", "delay_minutes": 14400}'::jsonb,
  '[{"type":"create_va_task","title":"Send final SMS to {firstName} — deep clean Day 10","task_type":"other","priority":"medium","description":"Suggested final SMS to send via OpenPhone:\n\n\"Last check in {firstName} — still want us to do that deep clean? Just reply yes and we''ll get you scheduled.\"\n\nReview, edit if needed, send, then mark this task done. If no response after this, manually move the lead to Closed lost.","suggested_message":"Last check in {firstName} — still want us to do that deep clean? Just reply yes and we''ll get you scheduled.","suggested_channel":"sms"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;


-- ═════════════════════════════════════════════════════════════════════════════
-- REGULAR CLEANING VARIANT (14-day window, 6 touches across 6 automations)
-- ═════════════════════════════════════════════════════════════════════════════

-- Day 1: call task
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Regular · Day 1 call',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Regular Cleaning", "delay_minutes": 1440}'::jsonb,
  '[{"type":"create_va_task","title":"Call {firstName} — regular cleaning quote follow-up","task_type":"call_lead","priority":"medium","description":"Regular cleaning quote was sent yesterday. Call to confirm receipt, answer questions, schedule first clean. Lower urgency than move-out — focus on relationship and addressing any concerns."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 3: review-and-send SMS check-in
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Regular · Day 3 SMS',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Regular Cleaning", "delay_minutes": 4320}'::jsonb,
  '[{"type":"create_va_task","title":"Send SMS to {firstName} — regular cleaning Day 3 check-in","task_type":"other","priority":"medium","description":"Suggested SMS to send via OpenPhone:\n\n\"Hey {firstName}! Just following up on the cleaning quote — any questions I can answer?\"\n\nReview, edit if needed, send, then mark this task done.","suggested_message":"Hey {firstName}! Just following up on the cleaning quote — any questions I can answer?","suggested_channel":"sms"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 5: review-and-send SMS check-in
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Regular · Day 5 SMS',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Regular Cleaning", "delay_minutes": 7200}'::jsonb,
  '[{"type":"create_va_task","title":"Send SMS to {firstName} — regular cleaning Day 5 check-in","task_type":"other","priority":"medium","description":"Suggested SMS to send via OpenPhone:\n\n\"Hi {firstName}, hope you''re well. Did you have a chance to review the quote? Happy to chat through details whenever.\"\n\nReview, edit if needed, send, then mark this task done.","suggested_message":"Hi {firstName}, hope you''re well. Did you have a chance to review the quote? Happy to chat through details whenever.","suggested_channel":"sms"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 8: review-and-send email value reinforcement
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Regular · Day 8 email',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Regular Cleaning", "delay_minutes": 11520}'::jsonb,
  '[{"type":"create_va_task","title":"Send email to {firstName} — why HNC for regular cleaning","task_type":"other","priority":"medium","description":"Suggested email — subject: \"Why HNC for your regular cleaning\".\n\nBody:\n---\nHi {firstName},\n\nWanted to share a few things that set us apart for regular cleaning:\n\n- Same cleaner every visit (consistency = trust)\n- 4.9-star avg rating across hundreds of Hawaii homes\n- Eco-friendly products that are safe for kids and pets\n- Frequency discounts: weekly 20% off, biweekly 15%, monthly 10%\n\nIf the quote works for you, just reply with your preferred frequency and we''ll get you on the schedule. Or text us at (808) 468-5356.\n\nMahalo,\nHawaii Natural Clean\n---\n\nReview, edit if needed, send via your email client (or Gmail), then mark this task done.","suggested_message":"Hi {firstName},\n\nWanted to share a few things that set us apart for regular cleaning:\n\n- Same cleaner every visit (consistency = trust)\n- 4.9-star avg rating across hundreds of Hawaii homes\n- Eco-friendly products that are safe for kids and pets\n- Frequency discounts: weekly 20% off, biweekly 15%, monthly 10%\n\nIf the quote works for you, just reply with your preferred frequency and we''ll get you on the schedule. Or text us at (808) 468-5356.\n\nMahalo,\nHawaii Natural Clean","suggested_channel":"email"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 11: 2nd call task
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Regular · Day 11 call',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Regular Cleaning", "delay_minutes": 15840}'::jsonb,
  '[{"type":"create_va_task","title":"Call {firstName} — 2nd regular cleaning attempt","task_type":"call_lead","priority":"medium","description":"Day 11. Quote''s been sitting nearly 2 weeks. Build relationship, address concerns, propose a start date."}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;

-- Day 14: review-and-send final SMS
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Tide · Quoted · Regular · Day 14 SMS final',
  'stage_entered',
  '{"stage": "Quoted", "service_type": "Regular Cleaning", "delay_minutes": 20160}'::jsonb,
  '[{"type":"create_va_task","title":"Send final SMS to {firstName} — regular cleaning Day 14","task_type":"other","priority":"medium","description":"Suggested final SMS to send via OpenPhone:\n\n\"Hey {firstName}, last check in — still want us to handle your cleaning? Just reply and we''ll get you on the schedule.\"\n\nReview, edit if needed, send, then mark this task done. If no response after this, manually move the lead to Closed lost.","suggested_message":"Hey {firstName}, last check in — still want us to handle your cleaning? Just reply and we''ll get you on the schedule.","suggested_channel":"sms"}]'::jsonb,
  false
) ON CONFLICT (name) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, actions = EXCLUDED.actions;


-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run after the migration to confirm)
-- ─────────────────────────────────────────────────────────────────────────────
-- All 16 Tide Quoted automations, ordered by variant + delay:
--   SELECT name, is_enabled, trigger_config->>'service_type' AS service,
--          (trigger_config->>'delay_minutes')::int / 1440 AS day_offset,
--          jsonb_array_length(actions) AS num_actions
--     FROM lead_automations
--    WHERE name LIKE 'Tide · Quoted · %'
--    ORDER BY trigger_config->>'service_type', (trigger_config->>'delay_minutes')::int
--
-- Sanity: should be 16 rows, all is_enabled=false, three service buckets,
-- all actions are create_va_task (no auto-send sms/email anywhere).
--
-- To confirm no auto-send actions made it in:
--   SELECT name FROM lead_automations
--    WHERE name LIKE 'Tide · Quoted · %'
--      AND (actions::text LIKE '%"type":"sms"%' OR actions::text LIKE '%"type":"email"%')
--
-- Should return ZERO rows.
