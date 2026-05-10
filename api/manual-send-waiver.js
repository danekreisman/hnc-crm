// /api/manual-send-waiver
//
// Sends the service-policies-agreement SMS to the client of an
// appointment, on demand from the appointment modal. Mirrors the
// auto-flow lead-book.js used to do at first booking, so the customer
// receives the same wording and the same agree.html?c=<clientId>&svc=<svcId>
// link.
//
// Skipped (returns 409) if the client already has policies_agreed_at
// set — no need to ask them again. Manual override possible by adding
// a `force` flag in a future iteration.
//
// On success: writes appointments.waiver_sent_at + _by, logs activity.

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

// Map a service label to the agree.html checklist id.
// Mirrors the mapping in lead-book.js / book.html so the customer sees
// the right service-specific scope on the policies page.
function serviceToSvcId(label) {
  if (!label) return null;
  const L = String(label).toLowerCase();
  if (L.indexOf('move') !== -1) return 'moveout';
  if (L.indexOf('deep') !== -1) return 'deep';
  if (L.indexOf('airbnb') !== -1 || L.indexOf('turnover') !== -1) return 'airbnb';
  if (L.indexOf('regular') !== -1) return 'regular';
  return null;
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

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendWaiver);
  if (invalid) return res.status(400).json(invalid);

  const { appointmentId } = req.body;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { data: appt, error: apptErr } = await db
      .from('appointments')
      .select(`
        id, service, client_id,
        clients ( id, name, phone, policies_agreed_at )
      `)
      .eq('id', appointmentId)
      .maybeSingle();
    if (apptErr) throw apptErr;
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.clients;
    if (!client) return res.status(400).json({ error: 'Appointment has no linked client.' });
    if (!client.phone) {
      return res.status(400).json({
        error: 'Client has no phone on file. Add a phone to the client record before sending a waiver.',
      });
    }

    // Skip if already agreed — saves the customer an unnecessary SMS.
    // Frontend can offer a force-resend in the future if Dane wants.
    if (client.policies_agreed_at) {
      return res.status(409).json({
        error: 'Client has already agreed to policies (' + client.policies_agreed_at + '). No need to resend.',
        alreadyAgreedAt: client.policies_agreed_at,
      });
    }

    const firstName = (client.name || 'there').split(' ')[0];
    const svcId = serviceToSvcId(appt.service);
    const policyLink = svcId
      ? `${BASE_URL}/agree.html?c=${client.id}&svc=${svcId}`
      : `${BASE_URL}/agree.html?c=${client.id}`;
    const message = `Hi ${firstName}! Before your first cleaning with Hawaii Natural Clean, please take a moment to review and agree to our service policies: ${policyLink} 🌺`;

    const phoneE164 = toE164(client.phone);
    const sendRes = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phoneE164, message }),
    }, TIMEOUTS.OPENPHONE);

    if (!sendRes.ok) {
      const body = await sendRes.text().catch(() => '<unreadable>');
      await logError('manual-send-waiver', new Error('send-sms ' + sendRes.status), {
        appointmentId, clientId: client.id, status: sendRes.status, body: body.slice(0, 500),
      });
      return res.status(502).json({ error: 'SMS service rejected the send. See Recent Errors.' });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('appointments')
      .update({ waiver_sent_at: sentAt, waiver_sent_by: userId })
      .eq('id', appointmentId);
    if (updErr) {
      await logError('manual-send-waiver:audit-update', updErr, { appointmentId });
    }

    await logActivity(
      'manual_waiver_sent',
      `${userEmail} manually sent waiver SMS to ${client.name || 'client'}`,
      { appointmentId, clientId: client.id, recipient: phoneE164, svcId, sentBy: userId },
    );

    return res.status(200).json({
      success: true,
      recipient: phoneE164,
      sentAt,
      policyLink,
    });
  } catch (err) {
    await logError('manual-send-waiver', err, { appointmentId });
    return res.status(500).json({ error: 'Could not send waiver. See Recent Errors.' });
  }
}
