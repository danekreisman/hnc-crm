// /api/vapid-public-key
//
// Returns the public VAPID key. The frontend needs this to subscribe to
// push notifications via the Push API. It's safe to expose publicly — the
// public key is meant for clients to use; it can verify pushes are signed
// by us but cannot send pushes itself.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(500).json({ error: 'VAPID_PUBLIC_KEY not configured' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ key });
}
