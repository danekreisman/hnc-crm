// api/portal/verify-otp.js
// Verifies a 6-digit OTP against portal_phone_otp. On success, finds or creates
// a Supabase auth user tied to the phone (linking to an existing clients row
// if we can match on phone), then returns a magic-link so the browser can
// establish a Supabase session.

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

// Non-routable internal domain, used only as a unique email for Supabase when
// the client authenticates with phone and has no email on file yet.
function phonePlaceholderEmail(phone) {
  const clean = phone.replace(/[^0-9]/g, '');
  return `phone-${clean}@phone.hnc-crm.internal`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone: rawPhone, code } = req.body || {};
    const phone = normalizePhone(rawPhone);
    if (!phone || !code) return res.status(400).json({ success: false, error: 'Phone and code required' });
    if (!/^\d{6}$/.test(String(code))) return res.status(400).json({ success: false, error: 'Invalid code format' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) return res.status(500).json({ success: false, error: 'Missing Supabase env vars' });
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    const code_hash = hashCode(String(code), phone);

    // Find the most recent unconsumed OTP for this phone
    const { data: otps, error: selErr } = await supa
      .from('portal_phone_otp')
      .select('*')
      .eq('phone', phone)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (selErr) return res.status(500).json({ success: false, error: selErr.message });
    const otp = otps && otps[0];
    if (!otp) return res.status(400).json({ success: false, error: 'No pending code. Request a new one.' });
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ success: false, error: 'Code expired. Request a new one.' });
    }
    if (otp.attempts >= 5) {
      return res.status(429).json({ success: false, error: 'Too many attempts. Request a new code.' });
    }
    if (otp.code_hash !== code_hash) {
      await supa.from('portal_phone_otp').update({ attempts: otp.attempts + 1 }).eq('id', otp.id);
      return res.status(400).json({ success: false, error: 'Incorrect code' });
    }

    // Mark consumed
    await supa.from('portal_phone_otp').update({ consumed_at: new Date().toISOString() }).eq('id', otp.id);

    // Find matching client (case-insensitive phone match)
    const { data: client } = await supa.from('clients')
      .select('id,name,email,phone,auth_user_id')
      .eq('phone', phone).maybeSingle();

    // Determine the email to associate with the Supabase auth user.
    // Prefer the client's real email if we have one; otherwise a synthetic placeholder.
    const email = (client && client.email) ? client.email : phonePlaceholderEmail(phone);

    // Find or create the auth user
    let userId = client && client.auth_user_id ? client.auth_user_id : null;

    if (!userId) {
      // Try listing by email via admin
      const { data: existingList } = await supa.auth.admin.listUsers({ page: 1, perPage: 200 });
      const existing = existingList && existingList.users && existingList.users.find(u =>
        (u.email && u.email.toLowerCase() === email.toLowerCase()) ||
        (u.phone && normalizePhone(u.phone) === phone)
      );
      if (existing) {
        userId = existing.id;
      } else {
        const { data: created, error: cErr } = await supa.auth.admin.createUser({
          email, phone, email_confirm: true, phone_confirm: true,
          user_metadata: { source: 'portal_phone_otp', client_id: client ? client.id : null }
        });
        if (cErr) return res.status(500).json({ success: false, error: 'Auth user create failed: ' + cErr.message });
        userId = created.user.id;
      }
    }

    // Ensure the client record is linked
    if (client && client.id && client.auth_user_id !== userId) {
      await supa.from('clients').update({ auth_user_id: userId }).eq('id', client.id);
    }

    // Generate a magic link to mint a session. The browser exchanges this.
    const { data: link, error: linkErr } = await supa.auth.admin.generateLink({
      type: 'magiclink',
      email
    });
    if (linkErr) return res.status(500).json({ success: false, error: 'Link generation failed: ' + linkErr.message });

    const props = link && (link.properties || link);
    return res.status(200).json({
      success: true,
      userId,
      email,
      actionLink: props.action_link,
      hashedToken: props.hashed_token,
      emailOtp: props.email_otp,
      tokenType: 'magiclink',
      clientLinked: !!(client && client.id)
    });
  } catch (err) {
    console.error('[verify-otp] error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
