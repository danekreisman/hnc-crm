-- Columns needed for invoice and policy reminder throttling
-- Run in Supabase SQL Editor

-- Throttle invoice reminders: track when last reminder was sent per invoice
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;

-- Track that policy reminder SMS was sent once to a client (never re-send)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS policy_reminder_sent_at TIMESTAMPTZ;

-- Indexes for the cron queries
CREATE INDEX IF NOT EXISTS idx_invoices_last_reminder ON invoices (last_reminder_at)
  WHERE status NOT IN ('paid', 'void', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_clients_policy_reminder ON clients (policy_reminder_sent_at)
  WHERE policies_agreed_at IS NULL;
