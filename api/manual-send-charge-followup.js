// /api/manual-send-charge-followup
//
// Sends the post-clean follow-up SMS after a card charge or invoice
// send. Triggered by the checkbox in the unified Charge modal. The
// message text is composed and edited by the user in the preview
// textarea, so the endpoint just delivers what it's given (validated
// for length).
//
// Audit columns are per-appointment (not per-client) — the question
// "did we send the follow-up FOR this clean?" is the relevant one.

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

const BASE_URL = 'https://hnc-crm.vercel.app';

async function logActivity(action, description, metadata = {}) {
  try {
    await fetch(process.env.SUPABASE_URL + '/rest/v1/activity_logs', {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ action, description, user_email: 'system', entity_type: action, metadata }),
    });
  } catch (_) { /* non-blocking */ }
}

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

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendChargeFollowup);
  if (invalid) return res.status(400).json(invalid);

  const { appointmentId, message } = req.body;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { data: appt, error: apptErr } = await db
      .from('appointments')
      .select('id, client_id, clients ( id, name, phone )')
      .eq('id', appointmentId)
      .maybeSingle();
    if (apptErr) throw apptErr;
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    const client = appt.clients;
    if (!client) return res.status(400).json({ error: 'Appointment has no linked client.' });
    if (!client.phone) {
      return res.status(400).json({
        error: 'Client has no phone on file. Add a phone before sending the follow-up.',
      });
    }

    const phoneE164 = toE164(client.phone);
    const sendRes = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phoneE164, message }),
    }, TIMEOUTS.OPENPHONE);

    if (!sendRes.ok) {
      const body = await sendRes.text().catch(() => '<unreadable>');
      await logError('manual-send-charge-followup', new Error('send-sms ' + sendRes.status), {
        appointmentId, clientId: client.id, status: sendRes.status, body: body.slice(0, 500),
      });
      return res.status(502).json({ error: 'SMS service rejected the send. See Recent Errors.' });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('appointments')
      .update({ charge_followup_sent_at: sentAt, charge_followup_sent_by: userId })
      .eq('id', appointmentId);
    if (updErr) await logError('manual-send-charge-followup:audit-update', updErr, { appointmentId });

    await logActivity(
      'manual_charge_followup_sent',
      `${userEmail} sent post-charge follow-up SMS to ${client.name || 'client'}`,
      { appointmentId, clientId: client.id, recipient: phoneE164, sentBy: userId, length: message.length },
    );

    return res.status(200).json({ success: true, recipient: phoneE164, sentAt });
  } catch (err) {
    await logError('manual-send-charge-followup', err, { appointmentId });
    return res.status(500).json({ error: 'Could not send follow-up SMS. See Recent Errors.' });
  }
}
