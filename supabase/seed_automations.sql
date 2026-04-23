-- ─────────────────────────────────────────────────────────────────────────────
-- HNC Automation Sequences — Seed File
-- ─────────────────────────────────────────────────────────────────────────────
-- Installs the full set of nurture, re-engagement, and win-back sequences.
-- Idempotent: safe to run multiple times. Uses name as the unique key.
-- AI personalization (ai_personalize: true) is ENABLED by default on every
-- action — messages pass through Claude with OpenPhone/SMS context before
-- sending. Falls back to the raw template if AI is unavailable.
-- ─────────────────────────────────────────────────────────────────────────────

-- Ensure we have a unique constraint on name so upserts work cleanly
ALTER TABLE lead_automations
  ADD CONSTRAINT IF NOT EXISTS lead_automations_name_unique UNIQUE (name);

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 1: NEW LEAD — Day 3 Follow-up
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'New Lead — Day 3 Follow-up',
  'days_since_response',
  '{"days": 3}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! Just checking in — still interested in that {service} quote? Happy to answer any questions. Mahalo!",
      "ai_personalize": true
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 2: NEW LEAD — Day 7 Final
-- Last touch before moving to long-term nurture.
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'New Lead — Day 7 Final Follow-up',
  'days_since_response',
  '{"days": 7}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! No pressure at all — just wanted to check in one more time about that {service} quote. We are here whenever you need us. Mahalo!",
      "ai_personalize": true
    },
    {
      "type": "segment_move",
      "new_segment": "nurture"
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 3: NURTURE — Month 1 Check-in
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Nurture — Month 1 Check-in',
  'days_in_segment',
  '{"segment": "nurture", "days": 30}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! It has been about a month since we first connected. Anything we can help you with around the home? Mahalo!",
      "ai_personalize": true
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 4: NURTURE — Month 3 Seasonal
-- Light, seasonal touch. AI will pick the right angle for the current season.
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Nurture — Month 3 Seasonal Check-in',
  'days_in_segment',
  '{"segment": "nurture", "days": 90}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! Thinking of you as the season shifts — let us know if you would like a fresh clean any time. Mahalo!",
      "ai_personalize": true
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 5: NURTURE — Month 6 Final Offer
-- Last active push. 10% off. If no response, moves to lost (indefinite light touch).
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Nurture — Month 6 Final Offer',
  'days_in_segment',
  '{"segment": "nurture", "days": 180}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! We would love to earn your business — take 10% off your first clean with us. Reply here to book. Mahalo!",
      "ai_personalize": true
    },
    {
      "type": "email",
      "subject": "A little something from Hawaii Natural Clean",
      "message": "Aloha {firstName}! It has been a while since we first connected, and we would genuinely love the chance to care for your home. Here is 10% off your first clean with us — just reply to this email or call us to book. We are small, local, and we show up.",
      "ai_personalize": true,
      "delay_minutes": 5
    },
    {
      "type": "segment_move",
      "new_segment": "lost"
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 6: ONE-TIME CLIENT — Day 30 Re-engagement
-- Fired 30 days after a lead is moved to the one_time segment.
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'One-time Client — Day 30 Check-in',
  'days_in_segment',
  '{"segment": "one_time", "days": 30}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! How is the home feeling? If you are ready for another clean, just say the word. Mahalo!",
      "ai_personalize": true
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 7: ONE-TIME CLIENT — Day 60 Offer
-- 10% off to bring them back for a second clean.
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'One-time Client — Day 60 Offer',
  'days_in_segment',
  '{"segment": "one_time", "days": 60}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! Ready for round two? 10% off your next clean — just reply. Mahalo!",
      "ai_personalize": true
    },
    {
      "type": "email",
      "subject": "10% off your next clean",
      "message": "Aloha {firstName}! It was a pleasure cleaning your home last time. We would love to have you back — here is 10% off your next clean as a small thank-you. Reply or call us to schedule whenever works. Mahalo!",
      "ai_personalize": true,
      "delay_minutes": 5
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 8: CANCELED CLIENT — Day 14 Gracious Exit
-- Soft, genuine. No offer. Just leaves the door open.
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Canceled — Day 14 Gracious',
  'days_in_segment',
  '{"segment": "canceled", "days": 14}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! No hard feelings — we understand life changes. If you ever need us again, we are right here. Mahalo for the time we had.",
      "ai_personalize": true
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEQUENCE 9: CANCELED CLIENT — Day 60 Win-back
-- 15% off to win them back. Last offer before moving to long-term nurture.
-- ══════════════════════════════════════════════════════════════════════════════
INSERT INTO lead_automations (name, trigger_type, trigger_config, actions, is_enabled)
VALUES (
  'Canceled — Day 60 Win-back',
  'days_in_segment',
  '{"segment": "canceled", "days": 60}'::jsonb,
  '[
    {
      "type": "sms",
      "message": "Aloha {firstName}! We would love to earn you back — 15% off your next clean if you give us another chance. Just reply. Mahalo!",
      "ai_personalize": true
    },
    {
      "type": "email",
      "subject": "We would love to have you back",
      "message": "Aloha {firstName}! We have been thinking about you and would genuinely love another chance to care for your home. Here is 15% off your next clean with us. Whatever changed — schedule, price, fit — we are open to hearing it and doing better. Mahalo for considering us again.",
      "ai_personalize": true,
      "delay_minutes": 5
    }
  ]'::jsonb,
  true
) ON CONFLICT (name) DO UPDATE SET
  trigger_type   = EXCLUDED.trigger_type,
  trigger_config = EXCLUDED.trigger_config,
  actions        = EXCLUDED.actions;
