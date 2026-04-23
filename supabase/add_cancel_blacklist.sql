-- ─────────────────────────────────────────────────────────────────────────────
-- Cancel + Blacklist support
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds:
--   1. do_not_contact (blacklist flag) on both leads and clients
--   2. segment + segment_moved_at on clients so they enter the canceled/one_time
--      sequences the same way leads do
--   3. canceled_reason on clients for record-keeping
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- Blacklist flag
ALTER TABLE clients ADD COLUMN IF NOT EXISTS do_not_contact boolean DEFAULT false;
ALTER TABLE leads   ADD COLUMN IF NOT EXISTS do_not_contact boolean DEFAULT false;

-- Segment tracking on clients (matches leads schema)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS segment text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS segment_moved_at timestamptz;

-- Reason for cancellation (for record-keeping / reporting)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS canceled_reason text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

-- Indexes to make the automation engine's segment queries fast
CREATE INDEX IF NOT EXISTS clients_segment_moved_at_idx ON clients (segment, segment_moved_at);
CREATE INDEX IF NOT EXISTS leads_do_not_contact_idx     ON leads (do_not_contact) WHERE do_not_contact = true;
CREATE INDEX IF NOT EXISTS clients_do_not_contact_idx   ON clients (do_not_contact) WHERE do_not_contact = true;
