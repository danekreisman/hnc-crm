// /api/manual-send-reschedule
//
// Sends a "your appointment has been rescheduled" notice to the client
// of an appointment. Fires both email (using send-email's existing
// 'reschedule' template) AND SMS — customer should hear it on whichever
// channel they pay attention to.
//
// Triggered manually from the appointment modal AFTER Dane has changed
// the date/time and saved. We don't track the OLD date here — the
// message just says "rescheduled to {newDate} at {newTime}", which is
// what the customer needs to know. Adding original-date tracking would
// require an audit table or a temp client-side stash; out of v1 scope.

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

const BASE_URL = 'https://hnc-crm.vercel.app';
const BUSINESS_PHONE = '(808) 468-5356';

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

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendReschedule);
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
        id, date, time, service, frequency, address, total_price,
        client_id, cleaner_id,
        clients ( name, email, phone ),
        cleaners!cleaner_id ( name )
      `)
      .eq('id', appointmentId)
      .maybeSingle();
    if (apptErr) throw apptErr;
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.clients;
    if (!client) return res.status(400).json({ error: 'Appointment has no linked client.' });
    if (!client.email && !client.phone) {
      return res.status(400).json({
        error: 'Client has no email or phone on file. Add at least one before sending a reschedule notice.',
      });
    }

    const prettyDate = (() => {
      try {
        return new Date(appt.date + 'T12:00:00').toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        });
      } catch (_) { return appt.date; }
    })();
    const firstName = (client.name || 'there').split(' ')[0];

    // Two parallel sends — email + SMS. Either can fail without
    // blocking the other. We mark the audit if EITHER lands.
    const sendResults = { email: null, sms: null };

    if (client.email) {
      try {
        const r = await fetchWithTimeout(`${BASE_URL}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to:         client.email.trim(),
            type:       'reschedule',
            clientName: client.name || '',
            // 'reschedule' template's signature is { oldDate, oldTime,
            // newDate, newTime, customSubject, customBody, service,
            // cleaner }. Old fields are optional — we omit them for v1.
            newDate:    prettyDate,
            newTime:    appt.time || '',
            service:    appt.service || 'Cleaning',
            cleaner:    appt.cleaners?.name || null,
          }),
        }, TIMEOUTS.RESEND);
        sendResults.email = { ok: !!(r && r.ok), status: r ? r.status : null, recipient: client.email };
        if (!r.ok) {
          const body = await r.text().catch(() => '<unreadable>');
          await logError('manual-send-reschedule:email', new Error('send-email ' + r.status), {
            appointmentId, status: r.status, body: body.slice(0, 300),
          });
        }
      } catch (err) {
        sendResults.email = { ok: false, error: err.message, recipient: client.email };
        await logError('manual-send-reschedule:email', err, { appointmentId });
      }
    } else {
      sendResults.email = { ok: false, skipped: 'no email on file' };
    }

    if (client.phone) {
      const phone = toE164(client.phone);
      const smsMsg = `Aloha ${firstName}! Your ${appt.service || 'cleaning'} with Hawaii Natural Clean has been rescheduled to ${prettyDate} at ${appt.time || ''}. Need to make changes? Reply or call ${BUSINESS_PHONE}. Mahalo! 🌺`;
      try {
        const r = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: phone, message: smsMsg }),
        }, TIMEOUTS.OPENPHONE);
        sendResults.sms = { ok: !!(r && r.ok), status: r ? r.status : null, recipient: phone };
        if (!r.ok) {
          const body = await r.text().catch(() => '<unreadable>');
          await logError('manual-send-reschedule:sms', new Error('send-sms ' + r.status), {
            appointmentId, status: r.status, body: body.slice(0, 300),
          });
        }
      } catch (err) {
        sendResults.sms = { ok: false, error: err.message, recipient: phone };
        await logError('manual-send-reschedule:sms', err, { appointmentId });
      }
    } else {
      sendResults.sms = { ok: false, skipped: 'no phone on file' };
    }

    const anyOk = (sendResults.email && sendResults.email.ok) || (sendResults.sms && sendResults.sms.ok);
    if (!anyOk) {
      return res.status(502).json({
        error: 'Reschedule notice could not be sent on any channel. See Recent Errors.',
        results: sendResults,
      });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('appointments')
      .update({ reschedule_sent_at: sentAt, reschedule_sent_by: userId })
      .eq('id', appointmentId);
    if (updErr) await logError('manual-send-reschedule:audit-update', updErr, { appointmentId });

    await logActivity(
      'manual_reschedule_sent',
      `${userEmail} manually sent reschedule notice for ${client.name || 'client'} to ${prettyDate} at ${appt.time || ''}`,
      { appointmentId, clientId: appt.client_id, results: sendResults, sentBy: userId },
    );

    return res.status(200).json({ success: true, sentAt, results: sendResults });
  } catch (err) {
    await logError('manual-send-reschedule', err, { appointmentId });
    return res.status(500).json({ error: 'Could not send reschedule notice. See Recent Errors.' });
  }
}
