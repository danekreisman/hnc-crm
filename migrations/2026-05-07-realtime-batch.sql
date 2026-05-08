-- Add cross-device realtime to four more tables (May 7, 2026 batch).
--
-- Each table backs a piece of UI someone might be staring at while a write
-- happens from another device or a cron job. Without realtime, the user
-- would see stale state until they manually refresh or switch views.
--
-- Tables added:
--   tasks                 (covered in 2026-05-07-tasks-realtime.sql, included
--                          here too in case that one wasn't run yet)
--   automations           (per-stage automation toggles)
--   lead_automations      (per-lead overrides)
--   lead_recommendations  (Daily List feed for the assistant)
--   client_tags           (cross-device tag updates on a client profile)
--
-- Each operation:
--   1. Skip silently if the table doesn't exist (some of these may have been
--      created manually in the Supabase dashboard rather than via this repo's
--      migration files; the DO block above each ALTER guards against that).
--   2. ALTER TABLE … REPLICA IDENTITY FULL so the WAL contains old-row data
--      and the realtime push includes both old + new on UPDATE/DELETE.
--   3. ADD TABLE … to publication supabase_realtime (idempotent — checks
--      pg_publication_tables first so re-running this migration is safe).

DO $$
DECLARE t text;
DECLARE tabs text[] := ARRAY['tasks','automations','lead_automations','lead_recommendations','client_tags'];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE NOTICE 'Skipping % (table does not exist)', t;
      CONTINUE;
    END IF;

    -- Set replica identity to FULL so old-row data is captured for UPDATE/DELETE
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);

    -- Add to publication if not already there
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      RAISE NOTICE 'Added % to supabase_realtime publication', t;
    ELSE
      RAISE NOTICE '% already in supabase_realtime publication', t;
    END IF;
  END LOOP;
END $$;
