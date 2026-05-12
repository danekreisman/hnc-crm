// /api/manual-send-review-sms
//
// Sends a Google-review-request SMS to the client. Wording mirrors
// /api/run-review-requests cron (same template) for consistency.
// Audit column shared with manual-send-review-email — both write
// clients.review_request_sent_at; activity log preserves the channel.

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';
import { logActivity } from './utils/log-activity.js';

const BASE_URL = 'https://hnc-crm.vercel.app';
const BUSINESS_NAME = 'Hawaii Natural Clean';
const DEFAULT_REVIEW_URL = 'https://www.google.com/search?q=Hawaii+Natural+Clean';

function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^0-9+]/g, '');
  return '+1' + s.replace(/\D/g, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHdr = req.headers.authorization || '';
  const tokenStr = authHdr.replace('Bearer ', '').trim();
  if (!tokenStr) return res.status(401).json({ error: 'Unauthorized' });
  const authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + tokenStr, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });
  const authUser = await authCheck.json().catch(() => ({}));
  const userId = authUser?.id || null;
  const userEmail = authUser?.email || 'unknown';

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendReviewSms);
  if (invalid) return res.status(400).json(invalid);
  const { clientId } = req.body;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { data: client, error: clErr } = await db
      .from('clients')
      .select('id, name, phone')
      .eq('id', clientId)
      .maybeSingle();
    if (clErr) throw clErr;
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.phone) {
      return res.status(400).json({
        error: 'Client has no phone on file. Add a phone before sending a review request.',
      });
    }

    let reviewUrl = DEFAULT_REVIEW_URL;
    try {
      const { data: setting } = await db
        .from('settings')
        .select('value')
        .eq('key', 'google_review_url')
        .maybeSingle();
      if (setting && setting.value) reviewUrl = setting.value;
    } catch (_) { /* fallthrough to default */ }

    const firstName = (client.name || 'there').split(' ')[0];
    const phoneE164 = toE164(client.phone);
    // Wording matches /api/run-review-requests so customer can't tell
    // whether the AI cron triggered it or Dane manually sent it.
    const message = `Aloha ${firstName}! 🌺 Thank you so much for choosing ${BUSINESS_NAME}. We hope your home is feeling fresh and clean! If you have a moment, we'd love it if you left us a Google review — it means the world to our small team: ${reviewUrl} Mahalo! 🌺`;

    const sendRes = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phoneE164, message }),
    }, TIMEOUTS.OPENPHONE);

    if (!sendRes.ok) {
      const body = await sendRes.text().catch(() => '<unreadable>');
      await logError('manual-send-review-sms', new Error('send-sms ' + sendRes.status), {
        clientId, status: sendRes.status, body: body.slice(0, 500),
      });
      await logActivity(
        'manual_review_sms_sent',
        `Review request SMS to ${client.name || 'client'} failed`,
        { client_id: clientId, channel: 'sms', recipient: phoneE164, body: message },
        { user_email: userEmail, status: 'failed', failure_reason: 'SMS service error ' + sendRes.status },
      );
      return res.status(502).json({ error: 'SMS service rejected the send. See Recent Errors.' });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('clients')
      .update({ review_request_sent_at: sentAt, review_request_sent_by: userId })
      .eq('id', clientId);
    if (updErr) await logError('manual-send-review-sms:audit-update', updErr, { clientId });

    await logActivity(
      'manual_review_sms_sent',
      `Review request SMS sent to ${client.name || 'client'}`,
      { client_id: clientId, channel: 'sms', recipient: phoneE164, sentBy: userId, body: message },
      { user_email: userEmail },
    );

    return res.status(200).json({ success: true, recipient: phoneE164, sentAt });
  } catch (err) {
    await logError('manual-send-review-sms', err, { clientId });
    try {
      await logActivity(
        'manual_review_sms_sent',
        'Review request SMS send failed',
        { client_id: clientId },
        { user_email: 'system', status: 'failed', failure_reason: err.message || 'Unknown error' },
      );
    } catch (_) {}
    return res.status(500).json({ error: 'Could not send review request SMS. See Recent Errors.' });
  }
}
