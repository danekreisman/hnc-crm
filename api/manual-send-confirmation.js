// /api/manual-send-confirmation
//
// Fires a booking-confirmation email to the client of an existing
// appointment, on demand from the appointment modal in the CRM. This
// is the manual analog of the cron-driven path that lead-book / 
// accept-public-booking optionally trigger after acceptance — same
// template, same `/api/send-email` endpoint, just user-initiated.
//
// On success: writes appointments.confirmation_sent_at + _by, logs an
// activity row, returns the recipient + sent-at so the UI can update
// the "last sent" indicator without re-fetching.
//
// Auth: Bearer token in Authorization header (same pattern as
// accept-public-booking). The triggering user's auth.users id becomes
// confirmation_sent_by for the audit trail.

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';
import { logActivity } from './utils/log-activity.js';

const BASE_URL = 'https://hnc-crm.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — verify the caller and capture their user id for the audit row.
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

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendConfirmation);
  if (invalid) return res.status(400).json(invalid);

  const { appointmentId } = req.body;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // Hydrate appointment + client. Single round-trip via embedded select.
    // Hourly columns (est_hours_low/high, invoice_hours_billed) are needed so
    // Deep/Move-out resends render the range or invoiced-hours total, not the
    // flat total_price field — matches the appointment view, the booking
    // confirmation email from accept-public-booking.js, and every other
    // display surface across the app.
    const { data: appt, error: apptErr } = await db
      .from('appointments')
      .select(`
        id, date, time, service, frequency, address, total_price,
        est_hours_low, est_hours_high, invoice_hours_billed,
        client_id, cleaner_id,
        clients ( name, email ),
        cleaners!cleaner_id ( name )
      `)
      .eq('id', appointmentId)
      .maybeSingle();
    if (apptErr) throw apptErr;
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.clients;
    if (!client?.email) {
      return res.status(400).json({
        error: 'Client has no email on file. Add an email to the client record before sending a confirmation.',
      });
    }

    const prettyDate = (() => {
      try {
        return new Date(appt.date + 'T12:00:00').toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        });
      } catch (_) { return appt.date; }
    })();

    /* Hourly-aware totalLine (2026-05-13): for Deep/Move-out appointments
       the customer was quoted a range, not a flat number. Three branches
       matching the appointment view (a55d1b2) and the booking confirmation
       email path (accept-public-booking.js e439eb0):
         1. Post-invoice (invoice_hours_billed > 0) → "$X.XX (Y cleaner-hrs)"
            using invoice_hours_billed × $70 (pre-tax, matches appt view).
         2. Pre-invoice hourly (est_hours_low + est_hours_high set) →
            "$A-B (X-Y cleaner-hours)" range, low × 70 to high × 70.
         3. Flat fallback → "$total_price" (unchanged for regular/airbnb/
            janitorial). */
    const HRATE = 70;
    let totalLine;
    if (appt.invoice_hours_billed != null && Number(appt.invoice_hours_billed) > 0) {
      const hrs = Number(appt.invoice_hours_billed);
      totalLine = `$${(hrs * HRATE).toFixed(2)} (${hrs} cleaner-hrs)`;
    } else if (appt.est_hours_low != null && appt.est_hours_high != null) {
      const lo = parseInt(appt.est_hours_low);
      const hi = parseInt(appt.est_hours_high);
      totalLine = `$${lo * HRATE}\u2013$${hi * HRATE} (${lo}\u2013${hi} cleaner-hours)`;
    } else {
      totalLine = appt.total_price ? `$${appt.total_price}` : null;
    }

    // Send the email via the existing template path. We use the same
    // body shape lead-book.js used to use, so the email renders exactly
    // as the automation would render it.
    const sendRes = await fetchWithTimeout(`${BASE_URL}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        suppressActivityLog: true,
        to:         client.email.trim(),
        subject:    `Booking confirmed \u2014 ${prettyDate}`,
        type:       'booking_confirmation',
        clientName: client.name || '',
        date:       prettyDate,
        time:       appt.time || '',
        service:    appt.service || 'Cleaning',
        frequency:  appt.frequency || null,
        address:    appt.address || null,
        cleaner:    appt.cleaners?.name || null,
        total:      totalLine,
      }),
    }, TIMEOUTS.RESEND);

    if (!sendRes.ok) {
      const body = await sendRes.text().catch(() => '<unreadable>');
      await logError('manual-send-confirmation', new Error('send-email ' + sendRes.status), {
        appointmentId, status: sendRes.status, body: body.slice(0, 500),
      });
      // Failure activity log + bell + push.
      await logActivity(
        'manual_confirmation_sent',
        `Confirmation email to ${client.name || 'client'} failed`,
        { appointmentId, client_id: appt.client_id, recipient: client.email },
        { user_email: userEmail, status: 'failed', failure_reason: 'Email service error ' + sendRes.status },
      );
      return res.status(502).json({ error: 'Email service rejected the send. See Recent Errors.' });
    }
    // Capture Resend's message_id so /api/resend-webhook can find this
    // activity_logs row when Resend later fires email.bounced or
    // email.complained events for the same message.
    const sendData = await sendRes.json().catch(() => ({}));
    const resendId = sendData && sendData.id ? sendData.id : null;

    // Record the audit. If this update fails we still return success —
    // the email went out — but log it so the UI's "last sent" indicator
    // staying stale is visible.
    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('appointments')
      .update({ confirmation_sent_at: sentAt, confirmation_sent_by: userId })
      .eq('id', appointmentId);
    if (updErr) {
      await logError('manual-send-confirmation:audit-update', updErr, { appointmentId });
    }

    await logActivity(
      'manual_confirmation_sent',
      `Confirmation email sent to ${client.name || 'client'} (${prettyDate})`,
      { appointmentId, client_id: appt.client_id, recipient: client.email, sentBy: userId, resend_id: resendId },
      { user_email: userEmail },
    );

    return res.status(200).json({
      success: true,
      recipient: client.email,
      sentAt,
    });
  } catch (err) {
    await logError('manual-send-confirmation', err, { appointmentId });
    // Best-effort failure activity log — appt/client may not have
    // loaded yet, so we guard. The bell/push side-effect from
    // logActivity still fires for whichever scope it CAN attribute to.
    try {
      await logActivity(
        'manual_confirmation_sent',
        'Confirmation email send failed',
        { appointmentId },
        { user_email: 'system', status: 'failed', failure_reason: err.message || 'Unknown error' },
      );
    } catch (_) {}
    return res.status(500).json({ error: 'Could not send confirmation. See Recent Errors.' });
  }
}
