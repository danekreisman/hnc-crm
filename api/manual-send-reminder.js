// /api/manual-send-reminder
//
// Manually triggers the day-before-style reminder SMS for one
// appointment. Mirrors the cron-driven `send-reminders.js` template
// (same wording) so a manual send and an automated send arrive
// indistinguishable from the customer's perspective.
//
// Sends to:
//   - The client (if phone on file)
//   - The assigned cleaner (if any). Mirrors the cron behaviour. If
//     Dane wants to remind only the customer, that's a future toggle —
//     v1 keeps it simple and matches automation behaviour.
//
// On success: writes appointments.reminder_sent_at + _by, logs activity.
// reminder_sent_at is the MANUAL last-sent — the cron does NOT write
// here so the audit trail stays clean.

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';
import { logActivity } from './utils/log-activity.js';

const BASE_URL = 'https://hnc-crm.vercel.app';
const BUSINESS_NAME = 'Hawaii Natural Clean';
const BUSINESS_PHONE = '(808) 468-5356';
const ADMIN_PHONE = '+18084685356';

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

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendReminder);
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
        id, date, time, service, address, duration_hours,
        client_id, cleaner_id,
        clients ( name, phone ),
        cleaners!cleaner_id ( name, phone )
      `)
      .eq('id', appointmentId)
      .maybeSingle();
    if (apptErr) throw apptErr;
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.clients;
    const cleaner = appt.cleaners;
    const service = appt.service || 'cleaning';
    const time = appt.time || '';
    const address = appt.address || '';
    const duration = appt.duration_hours ? `~${Math.round(appt.duration_hours)} hrs` : '';

    if (!client?.phone) {
      return res.status(400).json({
        error: 'Client has no phone on file. Add a phone to the client record before sending a reminder.',
      });
    }

    // Recipients we'll attempt — mirrors send-reminders.js exactly.
    const targets = [];
    const firstName = (client.name || 'there').split(' ')[0];
    const customerMsg = `Aloha ${firstName}! 🌺 Just a reminder that your ${service} with ${BUSINESS_NAME} is scheduled for tomorrow at ${time}. If you need to reschedule, call or text us at ${BUSINESS_PHONE}. See you then! Mahalo`;
    targets.push({ role: 'client', name: client.name, phone: toE164(client.phone), message: customerMsg });

    if (cleaner?.phone) {
      const cleanerMsg = `Reminder: You have a ${service} tomorrow at ${time}.\nClient: ${client.name || 'Client'}\nAddress: ${address}${duration ? `\nDuration: ${duration}` : ''}\nQuestions? Text Dane at ${ADMIN_PHONE}`;
      targets.push({ role: 'cleaner', name: cleaner.name, phone: toE164(cleaner.phone), message: cleanerMsg });
    }

    // Send each in sequence so partial failures are easy to attribute.
    // Continue past failures so the cleaner gets the reminder even if
    // the client send hiccups, etc.
    const results = [];
    for (const t of targets) {
      try {
        const r = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: t.phone, message: t.message }),
        }, TIMEOUTS.OPENPHONE);
        if (!r.ok) {
          const body = await r.text().catch(() => '<unreadable>');
          await logError('manual-send-reminder', new Error(t.role + ' send-sms ' + r.status), {
            appointmentId, role: t.role, phone: t.phone, status: r.status, body: body.slice(0, 300),
          });
          results.push({ role: t.role, name: t.name, phone: t.phone, ok: false, status: r.status, message: t.message });
        } else {
          results.push({ role: t.role, name: t.name, phone: t.phone, ok: true, message: t.message });
        }
      } catch (err) {
        await logError('manual-send-reminder', err, { appointmentId, role: t.role, phone: t.phone });
        results.push({ role: t.role, name: t.name, phone: t.phone, ok: false, error: err.message, message: t.message });
      }
    }

    const anySent = results.some((r) => r.ok);
    if (!anySent) {
      return res.status(502).json({
        error: 'Reminder could not be sent. See Recent Errors.',
        results,
      });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('appointments')
      .update({ reminder_sent_at: sentAt, reminder_sent_by: userId })
      .eq('id', appointmentId);
    if (updErr) {
      await logError('manual-send-reminder:audit-update', updErr, { appointmentId });
    }

    await logActivity(
      'manual_reminder_sent',
      `Reminder SMS sent to ${client.name || 'client'}`,
      { appointmentId, client_id: appt.client_id, results, sentBy: userId },
      { user_email: userEmail },
    );

    return res.status(200).json({ success: true, sentAt, results });
  } catch (err) {
    await logError('manual-send-reminder', err, { appointmentId });
    try {
      await logActivity(
        'manual_reminder_sent',
        'Reminder SMS send failed',
        { appointmentId },
        { user_email: 'system', status: 'failed', failure_reason: err.message || 'Unknown error' },
      );
    } catch (_) {}
    return res.status(500).json({ error: 'Could not send reminder. See Recent Errors.' });
  }
}
