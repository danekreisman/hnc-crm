-- Adds cleaner self-service invite + portal binding.
--
-- Two parts:
--   1. cleaner_invites: one-time tokens issued by admins. Cleaner clicks
--      the SMS link, signs in with Google, and the redeem endpoint binds
--      their authenticated email to the cleaner record by writing to
--      cleaners.auth_email.
--   2. cleaners.auth_email: the verified OAuth identity used to gate
--      cleaner portal access on subsequent logins. Kept separate from
--      cleaners.email (which is admin-entered contact info, not
--      necessarily a login-capable email).

BEGIN;

-- 1) Invite tokens
CREATE TABLE IF NOT EXISTS cleaner_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cleaner_id    UUID NOT NULL REFERENCES cleaners(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  used_by_email TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cleaner_invites_cleaner_id
  ON cleaner_invites(cleaner_id);

CREATE INDEX IF NOT EXISTS idx_cleaner_invites_token_active
  ON cleaner_invites(token) WHERE used_at IS NULL;

-- 2) Portal binding column on cleaners
ALTER TABLE cleaners
  ADD COLUMN IF NOT EXISTS auth_email TEXT;

CREATE INDEX IF NOT EXISTS idx_cleaners_auth_email_lower
  ON cleaners(LOWER(auth_email)) WHERE auth_email IS NOT NULL;

COMMIT;
