import { fetchWithTimeout, TIMEOUTS } from '../utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from '../utils/validate.js';
import { logError } from '../utils/error-logger.js';
import { requireAuth } from '../utils/auth-check.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // The cleaner must already be signed in (Google OAuth) before redeeming.
  // We trust ONLY the email that requireAuth extracts from the verified
  // session — never anything in req.body — so a forged email can't bind.
  const user = await requireAuth(req, res);
  if (!user) return; // requireAuth already sent 401
  const email = (user.email || '').toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'Authenticated user has no email on file.' });
  }

  const invalid = validateOrFail(req.body, SCHEMAS.cleanerInviteRedeem);
  if (invalid) return res.status(400).json(invalid);

  const { token } = req.body;

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json'
  };

  try {
    // Atomic redemption via RPC: marks token used + writes auth_email in one txn.
    const rpcRes = await fetchWithTimeout(
      `${SB_URL}/rest/v1/rpc/redeem_cleaner_invite`,
      {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({ _token: token, _email: email })
      },
      TIMEOUTS.SUPABASE
    );
    if (!rpcRes.ok) {
      const errBody = await rpcRes.text();
      await logError('cleaner-portal/redeem-invite', `RPC failed: ${rpcRes.status}`, {
        body: errBody.slice(0, 300),
        email
      });
      return res.status(500).json({ error: 'Could not redeem invite' });
    }
    const result = await rpcRes.json();

    if (!result || !result.ok) {
      const reason = result && result.error;
      const userMsg = reason === 'invite_invalid_or_expired'
        ? 'This invite link is invalid or has expired. Ask your admin for a new one.'
        : 'Invite could not be redeemed.';
      return res.status(400).json({ success: false, error: userMsg });
    }

    // Activity log (best-effort)
    try {
      await fetch(`${SB_URL}/rest/v1/activity_logs`, {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          action: 'cleaner_invite_redeemed',
          description: `Cleaner ${result.cleaner_name || result.cleaner_id} bound to ${email}`,
          user_email: email,
          entity_type: 'cleaner',
          entity_id: result.cleaner_id,
          metadata: { auth_email: email }
        })
      });
    } catch (_) { /* logging must not fail the request */ }

    return res.status(200).json({
      success: true,
      cleaner_id: result.cleaner_id,
      cleaner_name: result.cleaner_name
    });

  } catch (err) {
    await logError('cleaner-portal/redeem-invite', err, { email });
    return res.status(500).json({ error: err.message });
  }
}
