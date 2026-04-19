// api/portal/send-otp.js
// Generates a 6-digit OTP, stores a salted SHA-256 hash in portal_phone_otp,
// and sends the code to the phone via OpenPhone (Quo).
// Also looks up the matching client by phone so the client sees their name
// on the login screen after verification.

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9+]/g, '');
  if (!p.startsWith('+')) {
    if (p.length === 10) p = '+1' + p;
    else if (p.length === 11 && p.startsWith('1')) p = '+' + p;
    else p = '+' + p;
  }
  return p;
}

function hashCode(code, phone) {
  const salt = process.env.PORTAL_OTP_SALT || 'hnc-portal-otp-v1';
  return crypto.createHash('sha256').update(`${salt}:${phone}:${code}`).digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({ success: false, error: 'Server is missing Supabase env vars' });
    }
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Rate limit: at most 1 OTP per phone per 30 seconds
    const since = new Date(Date.now() - 30 * 1000).toISOString();
    const { data: recent } = await supa
      .from('portal_phone_otp')
      .select('id, created_at')
      .eq('phone', phone)
      .gte('created_at', since)
      .limit(1);
    if (recent && recent.length > 0) {
      return res.status(429).json({ success: false, error: 'Please wait before requesting another code' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const code_hash = hashCode(code, phone);
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Invalidate older unused codes for this phone
    await supa.from('portal_phone_otp')
      .update({ consumed_at: new Date().toISOString() })
      .eq('phone', phone)
      .is('consumed_at', null);

    const { error: insErr } = await supa.from('portal_phone_otp').insert({
      phone, code_hash, expires_at
    });
    if (insErr) return res.status(500).json({ success: false, error: insErr.message });

    // Send via OpenPhone (Quo)
    const QUO_API_KEY = process.env.QUO_API_KEY;
    const QUO_NUMBER = process.env.QUO_NUMBER;
    const msg = `Your Hawaii Natural Clean verification code is ${code}. It expires in 10 minutes.`;
    const r = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { 'Authorization': QUO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg, from: QUO_NUMBER, to: [phone] })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[send-otp] OpenPhone error', r.status, data);
      return res.status(502).json({ success: false, error: 'SMS provider failed', detail: data });
    }

    // Lookup client (optional, used only for greeting display client-side)
    const { data: client } = await supa.from('clients')
      .select('id,name').eq('phone', phone).maybeSingle();

    return res.status(200).json({ success: true, phone, clientHint: client ? { id: client.id, firstName: (client.name||'').split(' ')[0] } : null });
  } catch (err) {
    console.error('[send-otp] error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
