-- 003_add_quote_columns.sql
-- Adds quote tracking columns to leads table for auto-quote feature
-- Date: April 21, 2026

-- Add quote_total if not exists
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS quote_total DECIMAL(10, 2);

-- Add quote_data if not exists (stores full quote breakdown as JSON)
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS quote_data JSONB;

-- Create indexes for quote lookups
CREATE INDEX IF NOT EXISTS leads_quote_sent_idx ON public.leads(quote_sent_at DESC)
  WHERE quote_sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_quote_total_idx ON public.leads(quote_total)
  WHERE quote_total IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.leads.quote_total IS 'Auto-calculated quote total in USD, from calculate-quote API';
COMMENT ON COLUMN public.leads.quote_data IS 'Full quote breakdown JSON including subtotal, discount, duration, service details';
COMMENT ON COLUMN public.leads.quote_sent_at IS 'Timestamp when auto-quote was sent to lead via email/SMS';
