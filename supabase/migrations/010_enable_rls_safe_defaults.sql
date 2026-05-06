-- ─────────────────────────────────────────────────────────────────────────────
-- 010: Enable RLS on all public tables with safe defaults
-- ─────────────────────────────────────────────────────────────────────────────
-- Closes the Supabase Security Advisor finding "rls_disabled_in_public" by
-- enabling Row-Level Security on every table the codebase touches.
--
-- POLICY MODEL — applied here:
--   * Every public-facing table gets RLS enabled.
--   * Tables read or written FROM THE BROWSER (via the anon-keyed `db` client
--     inside index.html, client-portal.html, portal.html) get a permissive
--     `authenticated` policy. Anyone logged into Supabase auth — admins, VAs,
--     assistants, clients on portal, cleaners on portal — keeps full access.
--     Anonymous (logged-out) users are now BLOCKED.
--   * Tables only touched server-side via SUPABASE_SERVICE_ROLE_KEY get RLS
--     enabled with NO policies. Service role bypasses RLS, so server code
--     keeps working unchanged. Browser anon key cannot reach these tables
--     at all (no policy = deny by default for anon).
--
-- WHAT THIS DOES NOT DO (yet — flagged for follow-up):
--   * Horizontal privacy. The `authenticated` policy lets *any* logged-in
--     user read *any* row. So in theory a logged-in client could read
--     another client's invoices via direct API call. Cross-user policies
--     (e.g. clients only see their own invoices) need careful design and
--     thorough portal testing. Today's fix closes the public/anonymous hole;
--     tightening cross-user is a separate migration after Dane has tested
--     each portal end-to-end.
--   * Service-role-only tables get NO policies. If we ever switch them to
--     anon-key access, they will appear empty until policies are added.
--
-- IF THIS MIGRATION BREAKS SOMETHING:
--   The rollback is simple — for any table that suddenly stops working in
--   the browser, run:  ALTER TABLE <table_name> DISABLE ROW LEVEL SECURITY;
--   That instantly restores the pre-migration state for that one table while
--   keeping everything else locked down.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. CRM tables — accessed from index.html by authenticated CRM staff ────
-- These keep an "authenticated user has full access" policy so the CRM keeps
-- working. Each one gets RLS enabled and a single permissive policy.

DO $$
DECLARE
  t text;
  crm_tables text[] := ARRAY[
    'leads',
    'clients',
    'cleaners',
    'appointments',
    'tasks',
    'invoices',
    'messages',
    'notifications',
    'app_users',
    'settings',
    'activity_logs',
    'error_logs',
    'automations',
    'broadcasts',
    'pay_periods',
    'client_tags',
    'lead_automations',
    'lead_recommendations',
    'ai_booking_settings'
  ];
BEGIN
  FOREACH t IN ARRAY crm_tables LOOP
    -- Skip silently if the table doesn't exist (some entries in the array
    -- were scaffolded in code but the table was never created)
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'Skipping % (does not exist)', t;
      CONTINUE;
    END IF;

    -- Enable RLS (idempotent — safe to re-run)
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Drop the policy if it exists (so we can re-run this migration safely),
    -- then create it fresh.
    EXECUTE format('DROP POLICY IF EXISTS authenticated_full_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY authenticated_full_access ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;

-- ── 2. Server-only tables — accessed only via SERVICE_ROLE_KEY ─────────────
-- RLS gets enabled but no policies are added. Service role bypasses RLS,
-- so server code keeps working. Browser anon key is now locked out entirely.

DO $$
DECLARE
  t text;
  server_only_tables text[] := ARRAY[
    'lead_stage_events',
    'lead_automation_runs',
    'lead_comms_log',
    'broadcast_sends',
    'client_feedback',
    'client_portal_requests',
    'cleaner_integrations',
    'pricing_condition',
    'pricing_frequency_discount',
    'pricing_regular_bathrooms',
    'pricing_regular_bedrooms',
    'pricing_sqft',
    'portal_phone_otp'
  ];
BEGIN
  FOREACH t IN ARRAY server_only_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'Skipping % (does not exist)', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── 3. Migration tracking table — special case ─────────────────────────────
-- _migrations is internal infrastructure; lock it down completely.
ALTER TABLE IF EXISTS public._migrations ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (run these after applying to confirm correctness)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. Confirm RLS is enabled on every table:
--    SELECT tablename, rowsecurity FROM pg_tables
--      WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%'
--      ORDER BY rowsecurity, tablename;
--    (every row should show rowsecurity = true)
--
-- 2. Confirm policies exist on the CRM tables:
--    SELECT tablename, policyname, roles FROM pg_policies
--      WHERE schemaname = 'public'
--      ORDER BY tablename;
--
-- 3. Smoke-test the CRM:
--    - Reload the CRM in your browser
--    - Pipeline still loads leads ✓
--    - Click into a lead, see history ✓
--    - Open Clients tab, see clients ✓
--    - Open Calendar, see appointments ✓
--    - Settings page loads ✓
--    If any of these come up empty, the table needs RLS reviewed.
