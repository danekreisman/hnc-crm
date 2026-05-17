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

// ── Owner gate ─────────────────────────────────────────────────────────────────
// OWNER_EMAILS is the hardcoded ownership set. Owners can do anything,
// including managing other users (invite, revoke, change role). Reserved for
// the business owner — these emails always win, never overridden by the DB.
const OWNER_EMAILS = new Set([
  'dane.kreisman@gmail.com',
  'dane@hawaiinaturalclean.net'
]);

// requireOwner — for ownership-level actions only (user management, etc).
// Hardcoded-only, never consults the DB. Any endpoint that grants/revokes
// access to other users should call this instead of requireAdmin.
export async function requireOwner(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  const email = user.email ? user.email.toLowerCase() : '';
  if (!email || !OWNER_EMAILS.has(email)) {
    res.status(403).json({ error: 'owner_only', message: 'This operation requires owner privileges.' });
    return null;
  }
  return user;
}

// ── Admin gate (added 2026-04-30 fix 5/5 of Jan Vernon series, expanded 2026-05-17) ──
// Admin = (a) hardcoded owner, OR (b) active app_users row with role='admin'.
// Any endpoint that touches money or modifies privileged state should call
// this. VAs, assistants, and unknown users get 403.
//
// 2026-05-17 change: previously this was hardcoded-only. Now it honors the
// app_users.role='admin' value the Users tab has always allowed — so promoting
// someone to "admin" in Settings → Users actually grants them admin powers
// (Stripe charges, tip links, etc.) instead of being a UI-only label that
// silently 403s every privileged API call. Ownership-level actions (user
// management) moved to requireOwner.
export async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null; // requireAuth already responded with 401/403
  const email = user.email ? user.email.toLowerCase() : '';
  if (!email) {
    res.status(403).json({ error: 'admin_only', message: 'This operation requires admin privileges.' });
    return null;
  }
  // Owners always pass.
  if (OWNER_EMAILS.has(email)) return user;
  // Otherwise consult app_users for an active admin row. Service role bypasses
  // RLS so this works regardless of the user's own DB permissions. Fail-CLOSED
  // on any error — never grant admin if we can't verify.
  try {
    const { data, error } = await supabase
      .from('app_users')
      .select('role,active')
      .eq('email', email)
      .maybeSingle();
    if (error) {
      console.error('[requireAdmin] DB error:', error);
      res.status(500).json({ error: 'admin_check_failed', message: 'Could not verify admin status.' });
      return null;
    }
    if (data && data.active === true && data.role === 'admin') return user;
  } catch (err) {
    console.error('[requireAdmin] exception:', err);
    res.status(500).json({ error: 'admin_check_failed', message: 'Could not verify admin status.' });
    return null;
  }
  res.status(403).json({ error: 'admin_only', message: 'This operation requires admin privileges.' });
  return null;
}
