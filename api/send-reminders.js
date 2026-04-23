/**
 * POST /api/send-reminders  (called by Vercel cron daily at 4am UTC = 6pm HST)
 *
 * Finds all appointments scheduled for TOMORROW and sends:
 *   1. SMS to the customer — "your cleaning is tomorrow at [time]"
 *   2. SMS to the assigned cleaner — "you have a job tomorrow at [time] at [address]"
 *
 * Only fires for appointments with status 'scheduled' or 'assigned'.
 * Safe to run once per day — no deduplication needed since date filter is exact.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const BASE_URL      = 'https://hnc-crm.vercel.app';
const BUSINESS_NAME = 'Hawaii Natural Clean';
const BUSINESS_PHONE = '(808) 468-5356';
const ADMIN_PHONE   = '+18083484888';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // Tomorrow's date in YYYY-MM-DD (UTC — appointments stored in UTC)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    console.log(`[send-reminders] Looking for appointments on ${tomorrowStr}`);

    // Fetch tomorrow's appointments with client + cleaner info
    const { data: appointments, error } = await db
      .from('appointments')
      .select(`
        id, date, time, service, address, duration_hours, notes,
        client_id, cleaner_id,
        clients ( name, phone, email ),
        cleaners!cleaner_id ( name, phone )
      `)
      .eq('date', tomorrowStr)
      .in('status', ['scheduled', 'assigned'])
      .not('client_id', 'is', null);

    if (error) throw error;
    if (!appointments || appointments.length === 0) {
      console.log('[send-reminders] No appointments tomorrow');
      return res.status(200).json({ success: true, sent: 0, message: 'No appointments tomorrow' });
    }

    console.log(`[send-reminders] Found ${appointments.length} appointment(s) for ${tomorrowStr}`);

    let customersSent = 0, cleanersSent = 0, errors = [];

    for (const appt of appointments) {
      const client   = appt.clients;
      const cleaner  = appt.cleaners;
      const service  = appt.service || 'cleaning';
      const time     = appt.time || '';
      const address  = appt.address || '';
      const duration = appt.duration_hours ? `~${Math.round(appt.duration_hours)} hrs` : '';

      // ── 1. Customer reminder ───────────────────────────────────────────
      if (client?.phone) {
        const firstName = (client.name || 'there').split(' ')[0];
        const rawPhone  = client.phone.replace(/\D/g, '');
        const e164      = client.phone.startsWith('+') ? client.phone : `+1${rawPhone}`;

        const customerMsg = `Aloha ${firstName}! 🌺 Just a reminder that your ${service} with ${BUSINESS_NAME} is scheduled for tomorrow at ${time}. If you need to reschedule, call or text us at ${BUSINESS_PHONE}. See you then! Mahalo`;

        try {
          const r = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: e164, message: customerMsg }),
          }, TIMEOUTS.OPENPHONE);

          if (r.ok) {
            customersSent++;
            console.log(`[send-reminders] Customer SMS sent to ${firstName} (${e164})`);
          } else {
            throw new Error(`SMS API returned ${r.status}`);
          }
        } catch (err) {
          await logError('send-reminders', err, { stage: 'customer_sms', apptId: appt.id, phone: e164 });
          errors.push({ apptId: appt.id, type: 'customer_sms', error: err.message });
        }
      }

      // ── 2. Cleaner reminder ────────────────────────────────────────────
      if (cleaner?.phone) {
        const cleanerPhone = cleaner.phone.replace(/\D/g, '');
        const cleanerE164  = cleaner.phone.startsWith('+') ? cleaner.phone : `+1${cleanerPhone}`;
        const clientName   = client?.name || 'Client';

        const cleanerMsg = `Reminder: You have a ${service} tomorrow at ${time}.\nClient: ${clientName}\nAddress: ${address}${duration ? `\nDuration: ${duration}` : ''}\nQuestions? Text Dane at ${ADMIN_PHONE}`;

        try {
          const r = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: cleanerE164, message: cleanerMsg }),
          }, TIMEOUTS.OPENPHONE);

          if (r.ok) {
            cleanersSent++;
            console.log(`[send-reminders] Cleaner SMS sent to ${cleaner.name} (${cleanerE164})`);
          } else {
            throw new Error(`SMS API returned ${r.status}`);
          }
        } catch (err) {
          await logError('send-reminders', err, { stage: 'cleaner_sms', apptId: appt.id, cleanerId: appt.cleaner_id });
          errors.push({ apptId: appt.id, type: 'cleaner_sms', error: err.message });
        }
      }
    }

    return res.status(200).json({
      success: true,
      appointments: appointments.length,
      customersSent,
      cleanersSent,
      errors: errors.length ? errors : undefined,
    });

  } catch (err) {
    await logError('send-reminders', err, {});
    return res.status(500).json({ error: err.message });
  }
}
