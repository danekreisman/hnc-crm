-- Error logs table
-- Captures errors from all API functions so you can see what breaks
-- without digging through Vercel logs

CREATE TABLE IF NOT EXISTS error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,              -- Which API file threw the error (e.g., 'send-sms')
  message TEXT NOT NULL,             -- Error message
  stack TEXT,                        -- Stack trace if available
  context JSONB DEFAULT '{}',        -- Extra context (request data, IDs, etc.)
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  resolved BOOLEAN DEFAULT FALSE,    -- Mark as resolved once you've investigated
  resolved_at TIMESTAMPTZ,
  notes TEXT                         -- Optional notes about the resolution
);

CREATE INDEX IF NOT EXISTS idx_error_logs_source ON error_logs(source);
CREATE INDEX IF NOT EXISTS idx_error_logs_occurred_at ON error_logs(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_resolved ON error_logs(resolved);
