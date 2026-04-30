// api/portal/send-invite.js
//
// Admin-gated endpoint that sends an SMS to a cleaner inviting them to
// the cleaner portal at /portal. No invite token is generated and no
// DB write happens here — the OLD portal handles cleaner-record linking
// via Google sign-in + /api/portal/link-or-create.

import { fetchWithTimeout, TIMEOUTS } from '../utils/with-timeout.js';
import { logError } from '../utils/error-logger.js';
import { requireAuth } from '../utils/auth-check.js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUO_API_KEY = process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY;
const QUO_NUMBER = process.env.QUO_NUMBER || process.env.OPENPHONE_FROM_NUMBER;

const PORTAL_URL = 'https://hnc-crm.vercel.app/portal';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Admin auth — bails to 401 itself if no user
  const user = await requireAuth(req, res);
  if (!user) return;

  const cleaner_id = req.body && req.body.cleaner_id;
  if (!cleaner_id || typeof cleaner_id !== 'string') {
    return res.status(400).json({ error: 'cleaner_id_required' });
  }

  // 1) Look up cleaner phone + name
  const tShort = (TIMEOUTS && TIMEOUTS.short) || 8000;
  const lookupRes = await fetchWithTimeout(
    `${SB_URL}/rest/v1/cleaners?select=id,name,phone&id=eq.${encodeURIComponent(cleaner_id)}`,
    { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } },
    tShort
  );
  if (!lookupRes.ok) {
    await logError('portal/send-invite', `cleaner lookup failed: ${lookupRes.status}`, { cleaner_id });
    return res.status(500).json({ error: 'cleaner_lookup_failed', status: lookupRes.status });
  }
  const rows = await lookupRes.json();
  if (!rows.length) return res.status(404).json({ error: 'cleaner_not_found' });
  const cleaner = rows[0];
  if (!cleaner.phone) return res.status(400).json({ error: 'cleaner_no_phone' });

  // 2) Send SMS via Quo (OpenPhone API)
  const greeting = cleaner.name ? `Hi ${cleaner.name},` : 'Hi,';
  const smsBody = `${greeting} you've been invited to your Hawaii Natural Clean cleaner portal. Sign in here: ${PORTAL_URL}`;

  const tMed = (TIMEOUTS && TIMEOUTS.medium) || 12000;
  const smsRes = await fetchWithTimeout(
    'https://api.openphone.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Authorization': QUO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: smsBody,
        from: QUO_NUMBER,
        to: [cleaner.phone]
      })
    },
    tMed
  );

  if (!smsRes.ok) {
    let smsErr = '';
    try { smsErr = await smsRes.text(); } catch {}
    await logError('portal/send-invite', `Quo SMS failed: ${smsRes.status}`, {
      cleaner_id, response: smsErr.slice(0, 300)
    });
    return res.status(502).json({ ok: false, sms_sent: false, sms_status: smsRes.status, error: 'sms_failed' });
  }

  return res.status(200).json({ ok: true, sms_sent: true });
}
