// POST /api/portal/link-or-create
// Body: { access_token }   (the supabase session access_token from the browser)
// 1) Validates the JWT against Supabase to get the auth user.
// 2) Tries to find an existing client row by auth_user_id, then by case-insensitive email,
//    then by digits-only phone match.
// 3) If none found, creates a new client row with type='lead' and links auth_user_id.
// 4) If a brand-new client was created, fires admin notification (email+sms per settings).
// Returns: { client, created: boolean }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return data;
}

function digits(s) { return (s || '').toString().replace(/\D+/g, ''); }
function lc(s) { return (s || '').toString().trim().toLowerCase(); }

async function getAuthUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SERVICE_ROLE, 'Authorization': `Bearer ${token}` }
  });
  if (!r.ok) throw new Error('Invalid session');
  return r.json();
}

async function findExisting(user) {
  // 1) by auth_user_id
  const a = await sb(`clients?auth_user_id=eq.${user.id}&select=*`);
  if (Array.isArray(a) && a.length) return a[0];

  // 2) by email (case-insensitive, exclude phone-placeholder emails)
  const email = lc(user.email);
  if (email && !email.endsWith('@phone.hnc-crm.internal')) {
    const b = await sb(`clients?email=ilike.${encodeURIComponent(email)}&select=*`);
    if (Array.isArray(b) && b.length) return b[0];
  }

  // 3) by phone digits (compare last 10 digits to handle +1 vs no country code)
  const phoneFromMeta = user.phone || (user.user_metadata && user.user_metadata.phone) || '';
  const d = digits(phoneFromMeta);
  if (d && d.length >= 7) {
    const last10 = d.slice(-10);
    // pull a small batch and match in JS (clients table is small)
    const rows = await sb(`clients?phone=not.is.null&select=id,phone`);
    const hit = (rows || []).find(r => digits(r.phone).slice(-10) === last10);
    if (hit) {
      const full = await sb(`clients?id=eq.${hit.id}&select=*`);
      if (full && full[0]) return full[0];
    }
  }
  return null;
}

async function linkClient(clientId, authUserId) {
  const upd = await sb(`clients?id=eq.${clientId}`, {
    method: 'PATCH',
    body: JSON.stringify({ auth_user_id: authUserId })
  });
  return upd && upd[0];
}

async function createClient(user) {
  const email = lc(user.email);
  const phoneRaw = user.phone || (user.user_metadata && user.user_metadata.phone) || '';
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || (email ? email.split('@')[0] : 'New Client');
  const body = {
    name,
    email: email && !email.endsWith('@phone.hnc-crm.internal') ? email : null,
    phone: phoneRaw || null,
    type: 'lead',
    auth_user_id: user.id
  };
  const ins = await sb('clients', { method: 'POST', body: JSON.stringify(body) });
  return ins && ins[0];
}

async function notifyAdminNewSignup(client) {
  try {
    const subject = 'New Client Portal signup';
    const message = `A new person signed up for the client portal.\n\nName: ${client.name}\nEmail: ${client.email || '-'}\nPhone: ${client.phone || '-'}\nClient ID: ${client.id}`;
    await fetch(`https://${process.env.VERCEL_URL || 'hnc-crm.vercel.app'}/api/portal/notify-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message })
    });
  } catch (e) { /* non-fatal */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { access_token } = req.body || {};
    if (!access_token) { res.status(400).json({ error: 'Missing access_token' }); return; }
    const user = await getAuthUser(access_token);
    let client = await findExisting(user);
    let created = false;
    if (client) {
      if (!client.auth_user_id || client.auth_user_id !== user.id) {
        client = await linkClient(client.id, user.id);
      }
    } else {
      client = await createClient(user);
      created = true;
      notifyAdminNewSignup(client);
    }
    res.status(200).json({ client, created });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
