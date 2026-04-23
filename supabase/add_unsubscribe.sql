-- Session A: Add unsubscribe support
-- Run this in the Supabase SQL editor

ALTER TABLE leads   ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ DEFAULT NULL;

-- Partial indexes — fast lookups for "not unsubscribed" (the common case)
CREATE INDEX IF NOT EXISTS idx_leads_unsubscribed_at   ON leads   (unsubscribed_at) WHERE unsubscribed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clients_unsubscribed_at ON clients (unsubscribed_at) WHERE unsubscribed_at IS NULL;
