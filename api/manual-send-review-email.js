// /api/manual-send-review-email
//
// Sends a Google-review-request email to the client. Manual analog of
// the SMS path that /api/run-review-requests cron uses, just on the
// email channel. Audit timestamp is per-action (not per-channel) — both
// this endpoint and manual-send-review-sms write
// clients.review_request_sent_at. Activity log preserves the channel.

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';
import { logActivity } from './utils/log-activity.js';

const BASE_URL = 'https://hnc-crm.vercel.app';
const DEFAULT_REVIEW_URL = 'https://www.google.com/search?q=Hawaii+Natural+Clean';

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

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendReviewEmail);
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
      .select('id, name, email')
      .eq('id', clientId)
      .maybeSingle();
    if (clErr) throw clErr;
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.email) {
      return res.status(400).json({
        error: 'Client has no email on file. Add an email before sending a review request.',
      });
    }

    // Look up the configured Google review URL — same source the cron
    // uses. Falls back to a generic search if unset.
    let reviewUrl = DEFAULT_REVIEW_URL;
    try {
      const { data: setting } = await db
        .from('settings')
        .select('value')
        .eq('key', 'google_review_url')
        .maybeSingle();
      if (setting && setting.value) reviewUrl = setting.value;
    } catch (_) { /* fallthrough to default */ }

    const sendRes = await fetchWithTimeout(`${BASE_URL}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:         client.email.trim(),
        subject:    'Mahalo from Hawaii Natural Clean — would you leave a review?',
        type:       'review_request',
        clientName: client.name || '',
        reviewUrl,
      }),
    }, TIMEOUTS.RESEND);

    if (!sendRes.ok) {
      const body = await sendRes.text().catch(() => '<unreadable>');
      await logError('manual-send-review-email', new Error('send-email ' + sendRes.status), {
        clientId, status: sendRes.status, body: body.slice(0, 500),
      });
      await logActivity(
        'manual_review_email_sent',
        `Review request email to ${client.name || 'client'} failed`,
        { client_id: clientId, channel: 'email', recipient: client.email },
        { user_email: userEmail, status: 'failed', failure_reason: 'Email service error ' + sendRes.status },
      );
      return res.status(502).json({ error: 'Email service rejected the send. See Recent Errors.' });
    }
    // Capture Resend's message_id so /api/resend-webhook can attribute
    // any future bounce events back to this row.
    const sendData = await sendRes.json().catch(() => ({}));
    const resendId = sendData && sendData.id ? sendData.id : null;

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('clients')
      .update({ review_request_sent_at: sentAt, review_request_sent_by: userId })
      .eq('id', clientId);
    if (updErr) await logError('manual-send-review-email:audit-update', updErr, { clientId });

    await logActivity(
      'manual_review_email_sent',
      `Review request email sent to ${client.name || 'client'}`,
      { client_id: clientId, channel: 'email', recipient: client.email, sentBy: userId, resend_id: resendId },
      { user_email: userEmail },
    );

    return res.status(200).json({ success: true, recipient: client.email, sentAt });
  } catch (err) {
    await logError('manual-send-review-email', err, { clientId });
    try {
      await logActivity(
        'manual_review_email_sent',
        'Review request email send failed',
        { client_id: clientId },
        { user_email: 'system', status: 'failed', failure_reason: err.message || 'Unknown error' },
      );
    } catch (_) {}
    return res.status(500).json({ error: 'Could not send review request email. See Recent Errors.' });
  }
}
