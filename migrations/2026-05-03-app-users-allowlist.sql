-- HNC CRM: app_users allowlist (2026-05-03)
-- Gates which Google/email accounts are allowed to sign in to the admin CRM
-- (book.hawaiinaturalclean.com). Cleaner portal and client portal are
-- separate flows and out of scope.
--
-- Security model for v1:
-- - RLS NOT enabled. Anyone with a valid Supabase session can SELECT this
--   table (needed so the auth gate's allowlist check works during sign-in).
-- - Write permissions enforced at UI level only — the User Access settings
--   tab is hidden from VAs via .admin-only CSS class. A VA could in theory
--   bypass this by hitting the API directly with their token. Acceptable
--   risk for v1 since (a) only authorized users have tokens, (b) writes
--   are logged via invited_by + invited_at, (c) hardcoded ADMIN_EMAILS in
--   index.html cannot be removed via this table.
-- - Tighter security via RLS policies is a v2 task — would need policies
--   that read app_users from app_users (recursive but supported in pg).
--
-- Lockout protection: ADMIN_EMAILS in index.html (currently
-- dane.kreisman@gmail.com + dane@hawaiinaturalclean.net) ALWAYS authorize
-- regardless of this table's contents. If the table is dropped or all
-- rows deleted, those two emails still get in.

CREATE TABLE IF NOT EXISTS public.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role text NOT NULL DEFAULT 'va',
  active boolean NOT NULL DEFAULT true,
  invited_by text,
  invited_at timestamptz NOT NULL DEFAULT now()
);

-- Role guard
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_users_role_check'
      AND conrelid = 'public.app_users'::regclass
  ) THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT app_users_role_check CHECK (role IN ('admin', 'va'));
  END IF;
END $$;

-- Case-insensitive unique email — the auth gate normalizes to lowercase
-- before querying, so ensuring uniqueness on lower(email) prevents two
-- rows differing only in capitalization (Dane@... vs dane@...).
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_unique
  ON public.app_users (lower(email));

-- Seed the two hardcoded admin emails so they appear in the management UI.
-- Hardcoded fallback in index.html ensures they always work even if these
-- rows are deleted, but having them in the table makes the UI honest about
-- who has access.
INSERT INTO public.app_users (email, role, invited_by) VALUES
  ('dane.kreisman@gmail.com', 'admin', 'system'),
  ('dane@hawaiinaturalclean.net', 'admin', 'system')
ON CONFLICT DO NOTHING;
