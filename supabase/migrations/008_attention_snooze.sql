-- ─────────────────────────────────────────────────────────────────────────────
-- 008: attention_snoozed_until column
-- ─────────────────────────────────────────────────────────────────────────────
-- Powers the "✓ Handled" button on the "Needs your attention today" panel.
-- When clicked, the lead's row gets attention_snoozed_until = now() + 7d,
-- and the prioritizer skips any lead whose snooze is in the future.
--
-- The snooze is intentionally NOT a "permanently dismiss" — it expires after
-- 7 days so the lead reappears if they're still in a state that needs
-- attention. The frontend also auto-clears the snooze when the lead replies
-- or moves stages, so a re-engagement isn't blocked by an old "handled" tap.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS attention_snoozed_until TIMESTAMPTZ;

-- Index isn't strictly necessary at current scale (~100 leads) but cheap to
-- add and useful once the table grows. The prioritizer query is client-side
-- via leadDB so this primarily helps any future server-side filtering.
CREATE INDEX IF NOT EXISTS idx_leads_attn_snooze
  ON leads (attention_snoozed_until)
  WHERE attention_snoozed_until IS NOT NULL;
