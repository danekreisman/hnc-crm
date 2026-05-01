/**
 * POST /api/run-policy-reminders  (called by Vercel cron, daily at 6am UTC = 8pm HST)
 *
 * Finds clients with policies_agreed_at = NULL (manually created, never went
 * through the booking form) and sends them a one-time SMS with the agree.html link.
 *
 * Only sends once — after sending, records sent_at so they're never bugged again.
 * Skips clients with no phone or no upcoming appointments (no point chasing).
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';
import { isAutomationEnabled } from './utils/automation-gate.js';

const BASE_URL       = 'https://hnc-crm.vercel.app';
const BUSINESS_NAME  = 'Hawaii Natural Clean';
const BUSINESS_PHONE = '(808) 468-5356';


async function isNotifEnabled(db, clientId, key) {
  if (!clientId) return true;
  const { data } = await db.from('clients').select('notification_prefs').eq('id', clientId).maybeSingle();
  const prefs = { booking_confirmation:true, day_before_reminder:true, invoice_reminder:true, policy_reminder:true, post_clean_email:true, review_request:true, ...(data?.notification_prefs || {}) };
  return prefs[key] !== false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // Master automation gate
  const enabled = await isAutomationEnabled(db, 'policy_reminder_enabled');
  if (!enabled) {
    console.log('[run-policy-reminders] disabled — policy_reminder_enabled is not true. Skipping.');
    return res.status(200).json({ skipped: 'policy_reminder_enabled is FALSE', sent: 0 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    // Clients with no policy agreement AND a future/today appointment scheduled
    const { data: clients, error } = await db
      .from('clients')
      .select(`
        id, name, phone,
        appointments ( id, date, status, service )
      `)
      .is('policies_agreed_at', null)
      .is('policy_reminder_sent_at', null)
      .not('phone', 'is', null);

    if (error) throw error;
    if (!clients || clients.length === 0) {
      return res.status(200).json({ success: true, sent: 0, message: 'No clients need policy reminders' });
    }

    // Filter to only clients with an upcoming scheduled/assigned appointment
    const eligible = clients.filter(c =>
      (c.appointments || []).some(a =>
        a.date >= today && ['scheduled', 'assigned'].includes(a.status)
      )
    );

    if (eligible.length === 0) {
      return res.status(200).json({ success: true, sent: 0, message: 'No eligible clients (none with upcoming appointments)' });
    }

    let sent = 0;
    const errors = [];

    for (const client of eligible) {
      const firstName = (client.name || 'there').split(' ')[0];
      const phone = client.phone.replace(/\D/g, '');
      const e164  = client.phone.startsWith('+') ? client.phone : `+1${phone}`;

      // Pick the soonest upcoming scheduled/assigned appointment to determine service
      const upcoming = (client.appointments || [])
        .filter(a => a.date >= today && ['scheduled', 'assigned'].includes(a.status))
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      const svcRaw = String((upcoming && upcoming.service) || '').toLowerCase();
      let svcId = null;
      if (svcRaw.indexOf('move') !== -1) svcId = 'moveout';
      else if (svcRaw.indexOf('deep') !== -1) svcId = 'deep';
      else if (svcRaw.indexOf('airbnb') !== -1 || svcRaw.indexOf('turnover') !== -1) svcId = 'airbnb';
      else if (svcRaw.indexOf('regular') !== -1) svcId = 'regular';

      const agreeLink = svcId
        ? `${BASE_URL}/agree.html?c=${client.id}&svc=${svcId}`
        : `${BASE_URL}/agree.html?c=${client.id}`;

      const message = `Aloha ${firstName}! Before your upcoming cleaning with ${BUSINESS_NAME}, please take a moment to review and agree to our service policies: ${agreeLink} Questions? Call or text us at ${BUSINESS_PHONE}. Mahalo 🌺`;

      // Check notification prefs
      const policyNotifOn = await isNotifEnabled(db, client.id, 'policy_reminder');
      if (!policyNotifOn) { skipped++; continue; }

      try {
        const resp = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: e164, message }),
        }, TIMEOUTS.OPENPHONE);

        if (resp.ok) {
          // Mark so we never send this reminder again
          await db.from('clients').update({ policy_reminder_sent_at: new Date().toISOString() }).eq('id', client.id);
          sent++;
          console.log(`[run-policy-reminders] Sent policy link to ${client.name}`);
        } else {
          throw new Error(`SMS API returned ${resp.status}`);
        }
      } catch (err) {
        await logError('run-policy-reminders', err, { clientId: client.id });
        errors.push({ clientId: client.id, error: err.message });
      }
    }

    return res.status(200).json({ success: true, sent, errors: errors.length ? errors : undefined });

  } catch (err) {
    await logError('run-policy-reminders', err, {});
    return res.status(500).json({ error: err.message });
  }
}
