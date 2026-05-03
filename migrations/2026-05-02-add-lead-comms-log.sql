-- ──────────────────────────────────────────────────────────────────────
-- Migration: lead_comms_log table
-- Run in Supabase SQL Editor.
--
-- Per-lead outbound communication log. Every SMS / email sent to a lead
-- writes a row here so the lead profile can show "what we've sent and
-- when" without parsing free-form notes or cross-querying multiple tables.
--
-- Sources that should write here:
--   • /api/lead-followup-send (AI follow-up button) — kind='ai_followup'
--   • /api/run-automations    (cron-driven SMS/email) — kind='automation'
--   • Direct Message-Lead SMS — kind='manual' (future)
--
-- The lead_automation_runs table is complementary: it tracks which RULE
-- fired, this table tracks the actual COMMS SENT. Together they give a
-- full picture on the lead profile.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_comms_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('sms', 'email')),
  kind          text NOT NULL CHECK (kind IN ('ai_followup', 'automation', 'manual', 'owner_alert', 'auto_quote')),
  content       text,            -- the actual message body (or truncated preview)
  subject       text,            -- email subject (null for SMS)
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'skipped')),
  error_message text,            -- populated if status = 'failed'
  source_label  text,            -- e.g. "AI follow-up", "Day 3 Reminder", "Auto-quote on form submit"
  sent_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_comms_log_lead_id_sent_at_idx
  ON lead_comms_log (lead_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS lead_comms_log_kind_idx
  ON lead_comms_log (kind);
