import { fetchWithTimeout, TIMEOUTS } from '../utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from '../utils/validate.js';
import { logError } from '../utils/error-logger.js';
import { requireAuth } from '../utils/auth-check.js';

// Mirror of the frontend ADMIN_EMAILS list in index.html. Keep in sync until
// the allowlist moves to env or DB. Cleaner-portal invites are admin-only.
const ADMIN_EMAILS = ['dane.kreisman@gmail.com', 'dane@hawaiinaturalclean.net'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Admin gate — Supabase session required, and email must be on ADMIN_EMAILS.
  const user = await requireAuth(req, res);
  if (!user) return; // requireAuth already sent 401
  const callerEmail = (user.email || '').toLowerCase();
  if (!ADMIN_EMAILS.map(e => e.toLowerCase()).includes(callerEmail)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const invalid = validateOrFail(req.body, SCHEMAS.cleanerInvite);
  if (invalid) return res.status(400).json(invalid);

  const { cleaner_id } = req.body;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json'
  };

  try {
    // 1) Look up the cleaner (need name + phone + verify existence)
    const lookupRes = await fetchWithTimeout(
      `${SB_URL}/rest/v1/cleaners?select=id,name,phone&id=eq.${encodeURIComponent(cleaner_id)}&limit=1`,
      { headers: sbHeaders },
      TIMEOUTS.SUPABASE
    );
    if (!lookupRes.ok) {
      await logError('cleaner-portal/send-invite', `cleaner lookup failed: ${lookupRes.status}`, { cleaner_id });
      return res.status(500).json({ error: 'Could not look up cleaner' });
    }
    const cleaners = await lookupRes.json();
    if (!Array.isArray(cleaners) || cleaners.length === 0) {
      return res.status(404).json({ error: 'Cleaner not found' });
    }
    const cleaner = cleaners[0];
    if (!cleaner.phone || String(cleaner.phone).trim().length < 10) {
      return res.status(400).json({ error: "Cleaner has no phone number on file. Add one before inviting." });
    }

    // 2) Generate a 32-byte URL-safe random token
    const { randomBytes } = await import('crypto');
    const token = randomBytes(32)
      .toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    // 3) Insert invite row (7-day expiry)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const insertRes = await fetchWithTimeout(
      `${SB_URL}/rest/v1/cleaner_invites`,
      {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          cleaner_id,
          token,
          expires_at: expiresAt,
          created_by: callerEmail
        })
      },
      TIMEOUTS.SUPABASE
    );
    if (!insertRes.ok) {
      const errBody = await insertRes.text();
      await logError('cleaner-portal/send-invite', `cleaner_invites insert failed: ${insertRes.status}`, {
        cleaner_id, body: errBody.slice(0, 300)
      });
      return res.status(500).json({ error: 'Could not create invite' });
    }
    const insertData = await insertRes.json();
    const invite = Array.isArray(insertData) ? insertData[0] : insertData;

    // 4) Build invite URL from the request origin (works on any deploy domain)
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'hnc-crm.vercel.app';
    const origin = `${proto}://${host}`;
    const inviteUrl = `${origin}/cleaner-portal.html?invite=${encodeURIComponent(token)}`;

    // 5) Send SMS via Quo (same env vars and endpoint as send-sms.js)
    const QUO_API_KEY = process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY;
    const QUO_NUMBER = process.env.QUO_NUMBER || process.env.OPENPHONE_FROM_NUMBER;
    const greeting = cleaner.name ? `Hi ${cleaner.name.split(' ')[0]}, ` : '';
    const smsBody = `${greeting}you've been invited to the Hawaii Natural Clean cleaner portal. Sign in here: ${inviteUrl}\n\nDon't share this link — it's tied to your account.`;

    const smsRes = await fetchWithTimeout(
      'https://api.openphone.com/v1/messages',
      {
        method: 'POST',
        headers: { Authorization: QUO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: smsBody, from: QUO_NUMBER, to: [cleaner.phone] })
      },
      TIMEOUTS.OPENPHONE
    );
    const smsData = await smsRes.json().catch(() => ({}));

    if (!smsRes.ok) {
      await logError('cleaner-portal/send-invite', `Quo SMS failed: ${smsRes.status}`, {
        cleaner_id, invite_id: invite.id, response: smsData
      });
      // Don't roll back — admin can resend the same invite later.
      return res.status(200).json({
        success: false,
        invite_id: invite.id,
        sms_sent: false,
        error: 'Invite created but SMS failed to send. Try again or check the phone number.'
      });
    }

    // 6) Activity log (best-effort)
    try {
      await fetch(`${SB_URL}/rest/v1/activity_logs`, {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          action: 'cleaner_invited',
          description: `Cleaner portal invite sent to ${cleaner.name || cleaner_id}`,
          user_email: callerEmail,
          entity_type: 'cleaner',
          entity_id: cleaner_id,
          metadata: { phone: cleaner.phone, invite_id: invite.id, expires_at: expiresAt }
        })
      });
    } catch (_) { /* logging must not break the send */ }

    return res.status(200).json({
      success: true,
      invite_id: invite.id,
      sms_sent: true,
      expires_at: expiresAt
    });

  } catch (err) {
    await logError('cleaner-portal/send-invite', err, { cleaner_id });
    return res.status(500).json({ error: err.message });
  }
}
