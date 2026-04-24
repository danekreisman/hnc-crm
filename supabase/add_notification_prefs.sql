-- Add notification preferences to clients table
-- Run in Supabase SQL Editor

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{}'::jsonb;

-- Index for faster lookups (optional but good practice)
CREATE INDEX IF NOT EXISTS idx_clients_notif_prefs ON clients USING GIN (notification_prefs);

-- Existing clients default to all notifications ON (empty JSONB = all true per app logic)
-- No backfill needed
