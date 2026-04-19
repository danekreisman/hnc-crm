// api/portal/notify-admin.js
// Called after a client creates a client_portal_requests row.
// Reads the settings 'portal_notify_channels' (jsonb array like ["email","sms"])
// and fires Resend email + OpenPhone SMS to the admin accordingly.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { requestId } = req.body || {};
    if (!requestId) return res.status(400).json({ success: false, error: 'requestId required' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) return res.status(500).json({ success: false, error: 'Missing Supabase env vars' });
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Load the request + joined client
    const { data: reqRow, error: rErr } = await supa
      .from('client_portal_requests')
      .select('id, kind, status, payload, appointment_id, created_at, client_id, clients:client_id(name,email,phone)')
      .eq('id', requestId).maybeSingle();
    if (rErr || !reqRow) return res.status(404).json({ success: false, error: 'Request not found' });

    // Load notify channels
    const { data: cfg } = await supa.from('settings').select('value').eq('key','portal_notify_channels').maybeSingle();
    const channels = Array.isArray(cfg && cfg.value) ? cfg.value : ['email','sms'];

    const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
    const ADMIN_PHONE = process.env.ADMIN_PHONE;

    const kindLabel = {
      new_booking: 'New booking request',
      reschedule: 'Reschedule request',
      cancel: 'Cancellation request',
      profile_update: 'Profile update',
      message: 'Client message'
    }[reqRow.kind] || reqRow.kind;

    const client = reqRow.clients || {};
    const payload = reqRow.payload || {};
    const payloadStr = Object.keys(payload).map(k => `${k}: ${typeof payload[k]==='object' ? JSON.stringify(payload[k]) : payload[k]}`).join('\n');

    const subject = `[HNC Portal] ${kindLabel} from ${client.name||'unknown client'}`;
    const text = `${kindLabel}\nClient: ${client.name||''} (${client.email||''} ${client.phone||''})\nCreated: ${reqRow.created_at}\n\n${payloadStr}\n\nOpen the CRM → Portal Requests to approve or deny.`;

    const results = { email: null, sms: null };

    // Send email via Resend
    if (channels.includes('email') && ADMIN_EMAIL && process.env.RESEND_API_KEY) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM || 'HNC Portal <portal@hawaiinaturalclean.net>',
            to: [ADMIN_EMAIL],
            subject,
            text
          })
        });
        results.email = { ok: r.ok, status: r.status };
      } catch (e) { results.email = { ok: false, error: e.message }; }
    }

    // Send SMS via OpenPhone
    if (channels.includes('sms') && ADMIN_PHONE && process.env.QUO_API_KEY && process.env.QUO_NUMBER) {
      try {
        const smsText = `${kindLabel} from ${client.name||'client'}: ${Object.values(payload).slice(0,3).join(' | ').slice(0,200)}`;
        const r = await fetch('https://api.openphone.com/v1/messages', {
          method: 'POST',
          headers: { 'Authorization': process.env.QUO_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: smsText, from: process.env.QUO_NUMBER, to: [ADMIN_PHONE] })
        });
        results.sms = { ok: r.ok, status: r.status };
      } catch (e) { results.sms = { ok: false, error: e.message }; }
    }

    return res.status(200).json({ success: true, channels, results });
  } catch (err) {
    console.error('[notify-admin] error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
