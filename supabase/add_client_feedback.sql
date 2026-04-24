-- Client feedback table
CREATE TABLE IF NOT EXISTS client_feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  client_id      UUID REFERENCES clients(id) ON DELETE CASCADE,
  rating         TEXT NOT NULL CHECK (rating IN ('positive', 'negative')),
  message        TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_client ON client_feedback (client_id);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON client_feedback (rating);
