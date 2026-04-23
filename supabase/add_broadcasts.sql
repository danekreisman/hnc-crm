-- Session B: Holiday Broadcasts
-- Run this in the Supabase SQL editor

CREATE TABLE IF NOT EXISTS broadcasts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  holiday         TEXT,          -- 'easter' | '4th_of_july' | 'thanksgiving' | 'christmas' | 'custom'
  subject         TEXT NOT NULL,
  holiday_key     TEXT,          -- matches a key in the template library
  audience        TEXT NOT NULL DEFAULT 'both',  -- 'leads' | 'clients' | 'both'
  scheduled_for   TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
  recipient_count INTEGER DEFAULT 0,
  sent_count      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcast_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id    UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  recipient_id    UUID,
  recipient_type  TEXT,          -- 'lead' | 'client'
  sent_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(broadcast_id, email)    -- prevents double-sends
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_status        ON broadcasts (status);
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_for ON broadcasts (scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_broadcast_sends_bid      ON broadcast_sends (broadcast_id);
