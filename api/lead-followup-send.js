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

  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://hnc-crm.vercel.app';

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: lead, error: leadErr } = await db
      .from('leads')
      .select('id,name,phone,email,notes,do_not_contact')
      .eq('id', leadId)
      .maybeSingle();
    if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });

    // Respect the per-lead automation-exclusion flag. Set via the toggle pill
    // on the lead profile. When true, every cron-driven follow-up AND the
    // manual AI follow-up button refuse to send.
    if (lead.do_not_contact === true) {
      return res.status(403).json({
        error: 'This lead is excluded from automations (do_not_contact = true). Toggle the pill on the lead profile OFF to send.',
      });
    }

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
          const smsRes = await fetchWithTimeout(`${baseUrl}/api/send-sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: phoneE164, message: String(sms).trim() }),
          }, TIMEOUTS.QUO || 10000);
          const smsData = await smsRes.json();
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
          const emailRes = await fetchWithTimeout(`${baseUrl}/api/send-email`, {
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
          }, 15000);
          const emailData = await emailRes.json();
          if (emailData?.success) emailSent = true;
          else errors.push('Email failed: ' + (emailData?.error || `HTTP ${emailRes.status}`));
        } catch (emailErr) {
          errors.push('Email error: ' + emailErr.message);
        }
      }
    }

    // ── Update lead row ──────────────────────────────────────────────────
    if (smsSent || emailSent) {
      const channelLabel = [smsSent ? 'SMS' : null, emailSent ? 'Email' : null].filter(Boolean).join(' + ');
      const stamp = new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const noteLine = `[${stamp}] AI follow-up sent (${channelLabel})`;
      const newNotes = lead.notes ? `${lead.notes}\n${noteLine}` : noteLine;
      try {
        await db.from('leads').update({
          notes: newNotes,
          last_followup_sent_at: new Date().toISOString(),
        }).eq('id', leadId);
      } catch (updErr) {
        // Fallback if last_followup_sent_at column doesn't exist yet
        try {
          await db.from('leads').update({ notes: newNotes }).eq('id', leadId);
        } catch (_) {}
        console.warn('[lead-followup-send] update error (likely missing column):', updErr.message);
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
