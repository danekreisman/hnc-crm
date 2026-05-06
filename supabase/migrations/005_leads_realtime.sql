-- Enable Supabase Realtime on the `leads` table so the pipeline view
-- updates instantly when a lead is inserted, updated, or deleted from
-- any source (other browsers, webhooks, automations, the lead-capture API).
--
-- Per the project's realtime-tables rule (DEVELOPMENT_GUIDE → Known Pitfalls),
-- two things are required for reliable change emission, especially for DELETE:
--   1. Publication membership in `supabase_realtime`.
--   2. `REPLICA IDENTITY FULL` so old-row data is captured in WAL.

ALTER TABLE leads REPLICA IDENTITY FULL;

-- Idempotent add to the publication. If the table is already in the
-- publication, the second statement is a no-op (the DO block guards it).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'leads'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE leads';
  END IF;
END
$$;
