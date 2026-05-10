// /api/manual-resend-booking-link
//
// Re-sends the auto-quote SMS with the book.html?bt=<token> URL to a
// lead. Used when the lead lost the original SMS (most common loss
// case in the funnel).
//
// Behavior:
//   - If the lead has no booking_token, generate one and persist it
//     before sending. Older leads pre-date the token system.
//   - Message wording matches lead-capture.js's auto-quote SMS so the
//     lead sees the same template they got the first time.
//   - Writes leads.booking_link_resent_at + _by, logs activity.
//
// Auth: Bearer token (same pattern as the appointment-modal manual sends).

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';
import crypto from 'crypto';

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

  const invalid = validateOrFail(req.body, SCHEMAS.manualResendBookingLink);
  if (invalid) return res.status(400).json(invalid);
  const { leadId } = req.body;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { data: lead, error: leadErr } = await db
      .from('leads')
      .select('id, name, phone, service, quote_total, booking_token')
      .eq('id', leadId)
      .maybeSingle();
    if (leadErr) throw leadErr;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.phone) {
      return res.status(400).json({
        error: 'Lead has no phone on file. Add a phone before resending the booking link.',
      });
    }

    // Mint a token if missing. Older leads pre-date the token feature
    // so they may not have one. Persist before sending so the link
    // works when the customer clicks.
    let bookingToken = lead.booking_token;
    if (!bookingToken) {
      bookingToken = crypto.randomUUID();
      const { error: tokErr } = await db
        .from('leads')
        .update({ booking_token: bookingToken })
        .eq('id', leadId);
      if (tokErr) {
        await logError('manual-resend-booking-link:token-mint', tokErr, { leadId });
        return res.status(500).json({ error: 'Could not prepare booking link. See Recent Errors.' });
      }
    }

    const firstName = (lead.name || 'there').trim().split(/\s+/)[0];
    const totalStr = lead.quote_total ? `$${Number(lead.quote_total).toFixed(2)}` : null;
    const serviceLabel = lead.service || 'cleaning';
    // Wording mirrors api/lead-capture.js's auto-quote SMS template.
    const message = totalStr
      ? `Aloha ${firstName}! Your Hawaii Natural Clean quote is ${totalStr} for ${serviceLabel} 🌺\n\nBook now: https://book.hawaiinaturalclean.com/book?bt=${bookingToken}\n\nQuestions? Reply or call (808) 468-5356.`
      : `Aloha ${firstName}! Here's the link to book your ${serviceLabel} with Hawaii Natural Clean 🌺\n\nBook now: https://book.hawaiinaturalclean.com/book?bt=${bookingToken}\n\nQuestions? Reply or call (808) 468-5356.`;

    const phone = toE164(lead.phone);
    const sendRes = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone, message }),
    }, TIMEOUTS.OPENPHONE);

    if (!sendRes.ok) {
      const body = await sendRes.text().catch(() => '<unreadable>');
      await logError('manual-resend-booking-link', new Error('send-sms ' + sendRes.status), {
        leadId, status: sendRes.status, body: body.slice(0, 500),
      });
      return res.status(502).json({ error: 'SMS service rejected the send. See Recent Errors.' });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('leads')
      .update({ booking_link_resent_at: sentAt, booking_link_resent_by: userId })
      .eq('id', leadId);
    if (updErr) await logError('manual-resend-booking-link:audit-update', updErr, { leadId });

    await logActivity(
      'manual_booking_link_resent',
      `${userEmail} manually resent booking link to ${lead.name || 'lead'}`,
      { leadId, recipient: phone, mintedToken: !lead.booking_token, sentBy: userId },
    );

    return res.status(200).json({ success: true, recipient: phone, sentAt });
  } catch (err) {
    await logError('manual-resend-booking-link', err, { leadId });
    return res.status(500).json({ error: 'Could not resend booking link. See Recent Errors.' });
  }
}
