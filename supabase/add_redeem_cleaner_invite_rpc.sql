-- RPC for atomic invite redemption.
--
-- Frontend posts the invite token; server-side endpoint calls this RPC with
-- the token + the cleaner's authenticated email (verified by requireAuth on
-- the API side, never trusted from the request body). The RPC validates the
-- token (exists, unused, unexpired), then atomically marks it used and
-- writes the email to cleaners.auth_email — both updates land or neither does.
--
-- Returns a single JSON object: { ok, error?, cleaner_id?, cleaner_name? }.

CREATE OR REPLACE FUNCTION redeem_cleaner_invite(_token TEXT, _email TEXT)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  inv    cleaner_invites%ROWTYPE;
  c_name TEXT;
BEGIN
  SELECT * INTO inv
    FROM cleaner_invites
   WHERE token = _token
     AND used_at IS NULL
     AND expires_at > NOW()
   FOR UPDATE
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invite_invalid_or_expired');
  END IF;

  UPDATE cleaner_invites
     SET used_at = NOW(),
         used_by_email = _email
   WHERE id = inv.id;

  UPDATE cleaners
     SET auth_email = _email
   WHERE id = inv.cleaner_id
  RETURNING name INTO c_name;

  RETURN json_build_object(
    'ok',           true,
    'cleaner_id',   inv.cleaner_id,
    'cleaner_name', c_name
  );
END;
$$;
