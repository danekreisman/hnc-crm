-- ─────────────────────────────────────────────────────────────────────────────
-- 011: Allow authenticated writes to trigger-touched tables
-- ─────────────────────────────────────────────────────────────────────────────
-- Problem detected after running migration 010:
--   Marking a lead as lost from the CRM produced:
--     "new row violates row-level security policy for table "lead_stage_events""
--
-- Cause:
--   There's a Postgres trigger on `leads` that auto-inserts a row into
--   `lead_stage_events` whenever the stage column changes. That trigger
--   runs in the calling user's security context, NOT as the service role.
--   Because migration 010 enabled RLS on lead_stage_events with NO policies,
--   the authenticated browser session could update `leads` but the trigger's
--   downstream INSERT was rejected.
--
-- Fix:
--   Add an `authenticated` policy to lead_stage_events and a small set of
--   other audit/log tables that may be touched by triggers fired from
--   browser-originating writes. Same model as the CRM tables in 010 —
--   any logged-in user has full access; anonymous users remain locked out.
--
-- Tables promoted from server-only to authenticated-access:
--   lead_stage_events       — written by trigger when leads.stage changes
--   lead_automation_runs    — may be touched by triggers from automation flows
--   lead_comms_log          — may be touched by triggers from messaging flows
--   broadcast_sends         — touched during broadcast send fan-out
--   client_feedback         — touched when clients submit feedback (auth'd)
--
-- Tables that REMAIN server-only (no policy needed — never written from a
-- browser-originating action):
--   client_portal_requests, cleaner_integrations, pricing_*,
--   portal_phone_otp, _migrations
--
-- Idempotent: DROP POLICY IF EXISTS guard means safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
  promoted_tables text[] := ARRAY[
    'lead_stage_events',
    'lead_automation_runs',
    'lead_comms_log',
    'broadcast_sends',
    'client_feedback'
  ];
BEGIN
  FOREACH t IN ARRAY promoted_tables LOOP
    -- Skip silently if the table doesn't exist (defensive)
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'Skipping % (does not exist)', t;
      CONTINUE;
    END IF;

    -- RLS is already enabled by migration 010 — re-enable defensively in
    -- case 010 was partial.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Drop and recreate the policy so this migration is idempotent
    EXECUTE format('DROP POLICY IF EXISTS authenticated_full_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY authenticated_full_access ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION:
--   1. Mark a lead as lost from the CRM — should succeed without an RLS error
--   2. Bulk-move several leads to "Closed lost" — should succeed
--   3. Confirm policies exist:
--        SELECT tablename, policyname FROM pg_policies
--        WHERE schemaname='public'
--          AND tablename IN ('lead_stage_events','lead_automation_runs',
--                            'lead_comms_log','broadcast_sends','client_feedback');
-- ─────────────────────────────────────────────────────────────────────────────
