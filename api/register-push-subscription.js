// /api/register-push-subscription
//
// Frontend calls this after the user grants notification permission and the
// browser hands us a PushSubscription object. We persist the subscription
// keys in user_push_subscriptions (one row per device).
//
// POST body shape (registration):
//   {
//     action: 'register',
//     endpoint: '<push service URL>',
//     keys: { p256dh: '<base64>', auth: '<base64>' },
//     userAgent: 'iPhone Safari' (optional, helps user identify devices later)
//   }
//
// POST body shape (unregister, e.g. user revokes permission in-app):
//   { action: 'unregister', endpoint: '<push service URL>' }
//
// Auth: Bearer access token from the user's Supabase session. Same pattern
// as the other authed endpoints. We read user.id from the verified JWT
// rather than trusting any user_id in the request body.

const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';

async function getUserFromBearer(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token },
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await getUserFromBearer(req);
  if (!user || !user.id) return res.status(401).json({ error: 'not authenticated' });

  const body = req.body || {};
  const action = body.action || 'register';
  const endpoint = body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { 'Content-Type': 'application/json', 'apikey': SR, 'Authorization': 'Bearer ' + SR };

  if (action === 'unregister') {
    const r = await fetch(SUPABASE_URL + '/rest/v1/user_push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint),
      { method: 'DELETE', headers });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(500).json({ error: 'unregister failed', detail: t.slice(0, 300) });
    }
    return res.status(200).json({ ok: true, action: 'unregister' });
  }

  // Register (default action). Upsert by endpoint so re-subscribing on the
  // same device updates rather than creates duplicates.
  if (!body.keys || !body.keys.p256dh || !body.keys.auth) {
    return res.status(400).json({ error: 'keys.p256dh and keys.auth required' });
  }

  const row = {
    user_id: user.id,
    endpoint,
    p256dh_key: body.keys.p256dh,
    auth_key: body.keys.auth,
    user_agent: (body.userAgent || '').slice(0, 200),
    last_used_at: new Date().toISOString(),
  };

  const r = await fetch(SUPABASE_URL + '/rest/v1/user_push_subscriptions?on_conflict=endpoint',
    {
      method: 'POST',
      headers: Object.assign({}, headers, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(row),
    });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return res.status(500).json({ error: 'register failed', status: r.status, detail: t.slice(0, 300) });
  }
  return res.status(200).json({ ok: true, action: 'register' });
}
