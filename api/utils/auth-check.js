import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function requireAuth(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: no token' });
    return null;
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Unauthorized: invalid token' });
    return null;
  }
  // DENYLIST — these emails are permanently blocked at the auth layer.
  // Added 2026-04-30 after ex-VA leovellaortega8@gmail.com made unauthorized $195.54x4 charges to Jan Vernon.
  // Belt-and-suspenders: also banned at the Supabase auth layer via /api/admin/revoke-user.
  const BLOCKED_EMAILS = new Set([
    'leovellaortega8@gmail.com'
  ]);
  if (user && user.email && BLOCKED_EMAILS.has(user.email.toLowerCase())) {
    res.status(403).json({ error: 'access_revoked', message: 'This account has been revoked.' });
    return null;
  }
  return user;
}
