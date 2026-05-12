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
import { logActivity } from './utils/log-activity.js';

const BASE_URL = 'https://hnc-crm.vercel.app';

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

  const { appointmentId, clientId: bodyClientId } = req.body;
  // Cross-field rule: must provide exactly one of appointmentId / clientId.
  if (!appointmentId && !bodyClientId) {
    return res.status(400).json({ error: 'Provide either appointmentId or clientId.' });
  }
  if (appointmentId && bodyClientId) {
    return res.status(400).json({ error: 'Provide only one of appointmentId or clientId — not both.' });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // Resolve to (client, optional appointment, service-for-svc-mapping).
    // Two paths converge on the same send + audit logic below.
    let client = null;
    let apptForAudit = null; // appointment whose waiver_sent_at we'll stamp (if any)
    let svcSource = null;    // service string used to map the agree.html?svc= param

    if (appointmentId) {
      const { data: appt, error: apptErr } = await db
        .from('appointments')
        .select(`id, service, client_id, clients ( id, name, phone, policies_agreed_at )`)
        .eq('id', appointmentId)
        .maybeSingle();
      if (apptErr) throw apptErr;
      if (!appt) return res.status(404).json({ error: 'Appointment not found' });
      if (!appt.clients) return res.status(400).json({ error: 'Appointment has no linked client.' });
      client = appt.clients;
      apptForAudit = { id: appt.id };
      svcSource = appt.service;
    } else {
      // Client path — pull the client + their soonest upcoming
      // appointment (if any) so we can pick a sensible svc id and
      // mirror the cron's behaviour of stamping waiver_sent_at on
      // that appointment.
      const today = new Date().toISOString().split('T')[0];
      const { data: cl, error: clErr } = await db
        .from('clients')
        .select(`
          id, name, phone, policies_agreed_at,
          appointments ( id, date, status, service )
        `)
        .eq('id', bodyClientId)
        .maybeSingle();
      if (clErr) throw clErr;
      if (!cl) return res.status(404).json({ error: 'Client not found' });
      client = cl;
      const upcoming = (cl.appointments || [])
        .filter((a) => a.date >= today && ['scheduled', 'assigned'].includes(a.status))
        .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
      if (upcoming) {
        apptForAudit = { id: upcoming.id };
        svcSource = upcoming.service;
      }
    }

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

    // Mode: 'first' for the initial send, 'reminder' for follow-ups.
    // Auto-detect from policy_reminder_sent_at when client doesn't
    // pass it explicitly — saves the frontend from having to track
    // state. Reminder wording is softer ('just a friendly nudge')
    // since the customer's already seen the formal version.
    const requestedMode = req.body && req.body.mode;
    let mode = requestedMode === 'first' || requestedMode === 'reminder' ? requestedMode : null;
    if (!mode) {
      // Reload the client row to get the most current reminder timestamp
      // — the policy_reminder_sent_at column may have changed between
      // when we did the initial fetch and now.
      const { data: clRefresh } = await db
        .from('clients')
        .select('policy_reminder_sent_at')
        .eq('id', client.id)
        .maybeSingle();
      mode = (clRefresh && clRefresh.policy_reminder_sent_at) ? 'reminder' : 'first';
    }

    const firstName = (client.name || 'there').split(' ')[0];
    const svcId = serviceToSvcId(svcSource);
    const policyLink = svcId
      ? `${BASE_URL}/agree.html?c=${client.id}&svc=${svcId}`
      : `${BASE_URL}/agree.html?c=${client.id}`;
    const message = mode === 'reminder'
      ? `Hi ${firstName}, just a friendly nudge — we still need you to review and agree to our service policies before your appointment: ${policyLink} Mahalo! 🌺`
      : `Hi ${firstName}! Before your first cleaning with Hawaii Natural Clean, please take a moment to review and agree to our service policies: ${policyLink} 🌺`;

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
    // Write client-level audit (used by run-policy-reminders cron to dedupe + by client-profile UI).
    const { error: clUpdErr } = await db
      .from('clients')
      .update({ policy_reminder_sent_at: sentAt })
      .eq('id', client.id);
    if (clUpdErr) await logError('manual-send-waiver:client-audit-update', clUpdErr, { clientId: client.id });

    // Write appointment-level audit if we have one.
    if (apptForAudit && apptForAudit.id) {
      const { error: apptUpdErr } = await db
        .from('appointments')
        .update({ waiver_sent_at: sentAt, waiver_sent_by: userId })
        .eq('id', apptForAudit.id);
      if (apptUpdErr) await logError('manual-send-waiver:audit-update', apptUpdErr, { appointmentId: apptForAudit.id });
    }

    await logActivity(
      'manual_waiver_sent',
      `Waiver ${mode === 'reminder' ? 'reminder ' : ''}SMS sent to ${client.name || 'client'}`,
      { appointmentId: apptForAudit ? apptForAudit.id : null, client_id: client.id, recipient: phoneE164, svcId, sentBy: userId, source: appointmentId ? 'appointment' : 'client_profile', mode, body: message },
      { user_email: userEmail },
    );

    return res.status(200).json({
      success: true,
      recipient: phoneE164,
      sentAt,
      policyLink,
      mode,
    });
  } catch (err) {
    await logError('manual-send-waiver', err, { appointmentId, clientId: bodyClientId });
    try {
      await logActivity(
        'manual_waiver_sent',
        'Waiver SMS send failed',
        { appointmentId, client_id: bodyClientId || null },
        { user_email: 'system', status: 'failed', failure_reason: err.message || 'Unknown error' },
      );
    } catch (_) {}
    return res.status(500).json({ error: 'Could not send waiver. See Recent Errors.' });
  }
}
