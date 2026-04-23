-- VA Tasks table
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  title           TEXT NOT NULL,
  description     TEXT,
  type            TEXT DEFAULT 'other'
                  CHECK (type IN ('invoice','call_lead','call_client','project','other')),
  priority        TEXT DEFAULT 'medium'
                  CHECK (priority IN ('high','medium','low')),
  due_date        DATE,
  status          TEXT DEFAULT 'open'
                  CHECK (status IN ('open','completed')),
  completed_at    TIMESTAMPTZ,
  related_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  related_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  ai_brief        TEXT  -- AI-generated summary for call tasks
);

CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date  ON tasks (due_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_tasks_lead      ON tasks (related_lead_id) WHERE related_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_client    ON tasks (related_client_id) WHERE related_client_id IS NOT NULL;
