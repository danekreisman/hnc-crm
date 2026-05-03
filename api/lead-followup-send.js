/**
 * POST /api/lead-followup-send
 *
 * Sends the (possibly user-edited) follow-up content via SMS and/or email.
 *
 * Body: {
 *   leadId: string,
 *   sms?:   string,                     // omit/empty to skip SMS
 *   email?: { subject: string, body: string }, // omit to skip email
 * }
 *
 * Returns { success: true, smsSent, emailSent, errors[] }
 *
 * - SMS goes via /api/send-sms (OpenPhone)
 * - Email goes via /api/send-email (Resend)
 * - On success, updates leads row: appends a note + sets last_followup_sent_at
 * - TEST_MODE flag at top of file gates real sending to Dane's own phone/email
 *   during early testing. Flip to false when confident.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

// Set to true to ONLY send to Dane's own phone/email; useful for early rollout.
// Flip to false once tested with a real lead.
const TEST_MODE_DANE_ONLY = false;
const DANE_PHONE_DIGITS = '8082697636';
const DANE_EMAIL = 'dane@hawaiinaturalclean.net';

function _isTestSafeContact(phone, email) {
  if (!TEST_MODE_DANE_ONLY) return true;
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  if (phoneDigits.includes(DANE_PHONE_DIGITS)) return true;
  if (String(email || '').trim().toLowerCase() === DANE_EMAIL) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const _authHdr = req.headers.authorization || '';
  const _token = _authHdr.replace('Bearer ', '').trim();
  if (!_token) return res.status(401).json({ error: 'Unauthorized' });
  const _authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + _token, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!_authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });

  const { leadId, sms, email } = req.body || {};
  if (!leadId) return res.status(400).json({ error: 'leadId required' });
  const wantSms = sms && String(sms).trim().length > 0;
  const wantEmail = email && (email.subject || email.body);
  if (!wantSms && !wantEmail) return res.status(400).json({ error: 'Provide sms or email content' });

  // Hardcoded production URL — process.env.VERCEL_URL points to the
  // deployment-specific hostname which can hit deployment-protection
  // auth walls and return HTML instead of JSON. Match the pattern used
  // by api/run-automations.js + api/run-task-deadline-reminders.js.
  const BASE_URL = 'https://hnc-crm.vercel.app';

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: lead, error: leadErr } = await db
      .from('leads')
      .select('id,name,phone,email,notes,do_not_contact')
      .eq('id', leadId)
      .maybeSingle();
    if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });

    // NOTE: do_not_contact is intentionally NOT checked here. That flag means
    // "exclude from scheduled automations" (cron-driven Day-3 follow-up,
    // nurture sweepers, broadcasts) — NOT "never contact". The AI follow-up
    // button is a manual override the user explicitly clicks, so it bypasses
    // this flag. If a lead truly needs "never contact" semantics, delete the
    // lead or unsubscribe via the public unsubscribe link.

    if (!_isTestSafeContact(lead.phone, lead.email)) {
      return res.status(403).json({
        error: 'TEST_MODE_DANE_ONLY is on — this lead is not the test contact. Edit api/lead-followup-send.js to disable.',
      });
    }

    const errors = [];
    let smsSent = false;
    let emailSent = false;

    // ── SMS via OpenPhone ────────────────────────────────────────────────
    if (wantSms) {
      const phoneE164 = lead.phone
        ? (lead.phone.startsWith('+') ? lead.phone : '+1' + lead.phone.replace(/\D/g, ''))
        : null;
      if (!phoneE164) {
        errors.push('Lead has no phone number');
      } else {
        try {
          const smsRes = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: phoneE164, message: String(sms).trim() }),
          }, TIMEOUTS.OPENPHONE);
          // Read body as text first so we can give a useful error when the
          // response is HTML (e.g. Vercel auth wall) instead of the cryptic
          // "Unexpected token '<'" JSON parse error.
          const smsRaw = await smsRes.text();
          let smsData;
          try { smsData = JSON.parse(smsRaw); }
          catch (parseErr) {
            const preview = smsRaw.slice(0, 120);
            throw new Error(`/api/send-sms returned non-JSON (HTTP ${smsRes.status}): ${preview}`);
          }
          if (smsData?.success) smsSent = true;
          else errors.push('SMS failed: ' + (smsData?.error || `HTTP ${smsRes.status}`));
        } catch (smsErr) {
          errors.push('SMS error: ' + smsErr.message);
        }
      }
    }

    // ── Email via Resend ─────────────────────────────────────────────────
    if (wantEmail) {
      if (!lead.email) {
        errors.push('Lead has no email address');
      } else {
        try {
          const emailRes = await fetchWithTimeout(`${BASE_URL}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'generic',
              to: lead.email,
              subject: String(email.subject || '').trim() || 'Hawaii Natural Clean — following up',
              clientName: lead.name || '',
              service: '',
              date: '',
              time: '',
              cleaner: '',
              notes: String(email.body || '').trim(),
            }),
          }, TIMEOUTS.RESEND || 15000);
          const emailRaw = await emailRes.text();
          let emailData;
          try { emailData = JSON.parse(emailRaw); }
          catch (parseErr) {
            const preview = emailRaw.slice(0, 120);
            throw new Error(`/api/send-email returned non-JSON (HTTP ${emailRes.status}): ${preview}`);
          }
          if (emailData?.success) emailSent = true;
          else errors.push('Email failed: ' + (emailData?.error || `HTTP ${emailRes.status}`));
        } catch (emailErr) {
          errors.push('Email error: ' + emailErr.message);
        }
      }
    }

    // ── Write comms log rows ─────────────────────────────────────────────
    // One row per channel actually sent (or failed). Surfaces on the lead
    // profile's Comms log panel via /api/lead-comms-log.
    const logRows = [];
    if (wantSms) {
      logRows.push({
        lead_id: leadId,
        channel: 'sms',
        kind: 'ai_followup',
        content: String(sms || '').slice(0, 1000),
        status: smsSent ? 'sent' : 'failed',
        error_message: smsSent ? null : (errors.find(e => e.includes('SMS')) || 'unknown SMS error'),
        source_label: 'AI follow-up',
      });
    }
    if (wantEmail) {
      logRows.push({
        lead_id: leadId,
        channel: 'email',
        kind: 'ai_followup',
        content: String(email.body || '').slice(0, 1000),
        subject: String(email.subject || '').slice(0, 200),
        status: emailSent ? 'sent' : 'failed',
        error_message: emailSent ? null : (errors.find(e => e.includes('Email')) || 'unknown email error'),
        source_label: 'AI follow-up',
      });
    }
    if (logRows.length > 0) {
      try {
        const insRes = await db.from('lead_comms_log').insert(logRows);
        if (insRes.error) {
          // Most likely cause: migration hasn't been run yet. Don't fail the
          // request — just log so we know to apply the migration.
          console.warn('[lead-followup-send] comms log insert failed (run migration?):', insRes.error.message);
        }
      } catch (logErr) {
        console.warn('[lead-followup-send] comms log insert threw:', logErr.message);
      }
    }

    // ── Update lead row ──────────────────────────────────────────────────
    if (smsSent || emailSent) {
      const channelLabel = [smsSent ? 'SMS' : null, emailSent ? 'Email' : null].filter(Boolean).join(' + ');
      const stamp = new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const noteLine = `[${stamp}] AI follow-up sent (${channelLabel})`;
      const newNotes = lead.notes ? `${lead.notes}\n${noteLine}` : noteLine;

      // PostgREST/Supabase returns {error} on schema/constraint failures —
      // it does NOT throw. So we have to check res.error explicitly. Earlier
      // versions of this code used try/catch and silently lost every notes
      // update when last_followup_sent_at column was missing.
      const fullPayload = { notes: newNotes, last_followup_sent_at: new Date().toISOString() };
      const res1 = await db.from('leads').update(fullPayload).eq('id', leadId);
      if (res1.error) {
        // Most likely: last_followup_sent_at column doesn't exist. Retry
        // with notes-only so at least the audit trail in notes works.
        console.warn('[lead-followup-send] full update failed, retrying notes-only:', res1.error.message);
        const res2 = await db.from('leads').update({ notes: newNotes }).eq('id', leadId);
        if (res2.error) {
          console.error('[lead-followup-send] notes-only update ALSO failed:', res2.error.message);
        }
      }
    }

    return res.status(200).json({
      success: smsSent || emailSent,
      smsSent,
      emailSent,
      errors,
    });
  } catch (err) {
    await logError('lead-followup-send', err, { leadId });
    return res.status(500).json({ error: err.message });
  }
}
