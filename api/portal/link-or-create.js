// POST /api/portal/link-or-create
// Body: { access_token } — supabase session token from browser
// Behavior:
//   1. Validate JWT, get auth user
//   2. Try to match an existing client (by auth_user_id, email, phone-last-10)
//      - If found: link auth_user_id (if not already), return { client, created:false, isLead:false }
//   3. If no client match: insert a row in `leads` (not clients), fire admin notification,
//      return { client: synthetic, created:true, isLead:true, leadId }
//      The synthetic 'client' object has id=null, is_lead=true, and basic profile fields,
//      so the portal can render a minimal 'thanks, we'll reach out' state.

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

async function findExistingClient(user) {
  const a = await sb(`clients?auth_user_id=eq.${user.id}&select=*`);
  if (Array.isArray(a) && a.length) return a[0];

  const email = lc(user.email);
  if (email && !email.endsWith('@phone.hnc-crm.internal')) {
    const b = await sb(`clients?email=ilike.${encodeURIComponent(email)}&select=*`);
    if (Array.isArray(b) && b.length) return b[0];
  }

  const phoneFromMeta = user.phone || (user.user_metadata && user.user_metadata.phone) || '';
  const d = digits(phoneFromMeta);
  if (d && d.length >= 7) {
    const last10 = d.slice(-10);
    const rows = await sb(`clients?phone=not.is.null&select=id,phone`);
    const hit = (rows || []).find(r => digits(r.phone).slice(-10) === last10);
    if (hit) {
      const full = await sb(`clients?id=eq.${hit.id}&select=*`);
      if (full && full[0]) return full[0];
    }
  }
  return null;
}

async function findExistingLead(user) {
  const email = lc(user.email);
  if (email && !email.endsWith('@phone.hnc-crm.internal')) {
    const rows = await sb(`leads?email=ilike.${encodeURIComponent(email)}&select=*`);
    if (Array.isArray(rows) && rows.length) return rows[0];
  }
  const phoneFromMeta = user.phone || (user.user_metadata && user.user_metadata.phone) || '';
  const d = digits(phoneFromMeta);
  if (d && d.length >= 7) {
    const last10 = d.slice(-10);
    const rows = await sb(`leads?phone=not.is.null&select=id,phone`);
    const hit = (rows || []).find(r => digits(r.phone).slice(-10) === last10);
    if (hit) {
      const full = await sb(`leads?id=eq.${hit.id}&select=*`);
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

async function createLead(user) {
  const email = lc(user.email);
  const phone = user.phone || (user.user_metadata && user.user_metadata.phone) || '';
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || (email ? email.split('@')[0] : 'New Portal Signup');
  const body = {
    name,
    email: email && !email.endsWith('@phone.hnc-crm.internal') ? email : null,
    phone: phone || null,
    source: 'client_portal',
    stage: 'new',
    notes: 'Self-serve signup via client portal'
  };
  const ins = await sb('leads', { method: 'POST', body: JSON.stringify(body) });
  return ins && ins[0];
}

async function notifyAdminNewLead(lead) {
  try {
    const host = process.env.VERCEL_URL || 'hnc-crm.vercel.app';
    const subject = 'New Client Portal signup (Lead)';
    const message = `A new person signed up for the client portal.\n\nName: ${lead.name || '-'}\nEmail: ${lead.email || '-'}\nPhone: ${lead.phone || '-'}\nLead ID: ${lead.id}\n\nReview in the Leads pipeline.`;
    await fetch(`https://${host}/api/portal/notify-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message })
    });
  } catch (e) { /* non-fatal */ }
}

function leadToSyntheticClient(lead, authUser) {
  // Shape matches enough of a `clients` row that the portal UI can render profile info,
  // but includes is_lead:true so the UI can show the 'thanks, we will reach out' banner
  // and hide client-only features.
  return {
    id: null,
    auth_user_id: authUser.id,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    address: lead.address || '',
    is_lead: true,
    lead_id: lead.id
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { access_token } = req.body || {};
    if (!access_token) { res.status(400).json({ error: 'Missing access_token' }); return; }
    const user = await getAuthUser(access_token);

    // 1) Existing client?
    let client = await findExistingClient(user);
    if (client) {
      if (!client.auth_user_id || client.auth_user_id !== user.id) {
        client = await linkClient(client.id, user.id);
      }
      res.status(200).json({ client, created: false, isLead: false });
      return;
    }

    // 2) Existing lead (returning user who signed up before)?
    let lead = await findExistingLead(user);
    if (lead) {
      const synth = leadToSyntheticClient(lead, user);
      res.status(200).json({ client: synth, created: false, isLead: true, leadId: lead.id });
      return;
    }

    // 3) Brand-new signup: create lead + notify admin
    lead = await createLead(user);
    notifyAdminNewLead(lead);
    const synth = leadToSyntheticClient(lead, user);
    res.status(200).json({ client: synth, created: true, isLead: true, leadId: lead.id });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
}
