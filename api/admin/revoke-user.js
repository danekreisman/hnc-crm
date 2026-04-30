// api/admin/revoke-user.js
//
// Admin-gated emergency endpoint for revoking a Supabase auth user.
// Usage: POST { email: "user@example.com" }
// - Looks up the auth.users row by email
// - Sets banned_until to year 9999 (so they cannot sign in)
// - Deletes all their active sessions
// - Returns the user_id and timing for audit purposes
//
// Created 2026-04-30 in response to ex-VA Leo Vella Ortega charging Jan Vernon
// $195.54 four times in nine seconds without authorization.

import { fetchWithTimeout, TIMEOUTS } from '../utils/with-timeout.js';
import { logError } from '../utils/error-logger.js';
import { requireAuth } from '../utils/auth-check.js';

const SB_URL = process.env.SUPABASE_URL;
const SB_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const email = (req.body && typeof req.body.email === 'string') ? req.body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'email_required' });
  }

  const t = (TIMEOUTS && TIMEOUTS.medium) || 12000;

  // 1) Look up the user in auth.users via the GoTrue admin API.
  //    GET /auth/v1/admin/users?filter=email
  let lookupRes;
  try {
    lookupRes = await fetchWithTimeout(
      `${SB_URL}/auth/v1/admin/users?filter=${encodeURIComponent('email.eq.' + email)}`,
      { headers: { apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC } },
      t
    );
  } catch (e) {
    await logError('admin/revoke-user', 'lookup_threw', { err: String(e), email });
    return res.status(500).json({ error: 'lookup_threw', detail: String(e) });
  }
  if (!lookupRes.ok) {
    const txt = await lookupRes.text().catch(() => '');
    await logError('admin/revoke-user', 'lookup_failed', { status: lookupRes.status, body: txt.slice(0, 300), email });
    return res.status(500).json({ error: 'lookup_failed', status: lookupRes.status });
  }
  const lookupBody = await lookupRes.json();
  // GoTrue admin returns either { users: [...] } or [...] depending on filter
  const users = Array.isArray(lookupBody) ? lookupBody : (lookupBody.users || []);
  // Defensive: GoTrue's filter param can be flaky — verify email match locally
  const target = users.find(u => (u.email || '').toLowerCase() === email);
  if (!target) {
    return res.status(404).json({ error: 'user_not_found', email, totalReturned: users.length });
  }
  const userId = target.id;

  // 2) Ban the user by setting ban_duration to a long value (876000h = 100 years)
  //    PUT /auth/v1/admin/users/{user_id}
  const banRes = await fetchWithTimeout(
    `${SB_URL}/auth/v1/admin/users/${userId}`,
    {
      method: 'PUT',
      headers: { apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ban_duration: '876000h' })
    },
    t
  );
  let banOk = banRes.ok;
  let banErr = null;
  if (!banOk) {
    banErr = await banRes.text().catch(() => '');
    await logError('admin/revoke-user', 'ban_failed', { status: banRes.status, body: banErr.slice(0, 300), userId, email });
  }

  // 3) Sign the user out everywhere — invalidates all refresh tokens & active sessions.
  //    POST /auth/v1/admin/users/{user_id}/logout
  const logoutRes = await fetchWithTimeout(
    `${SB_URL}/auth/v1/admin/users/${userId}/logout`,
    {
      method: 'POST',
      headers: { apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global' })
    },
    t
  );
  const logoutOk = logoutRes.ok;
  let logoutErr = null;
  if (!logoutOk) {
    logoutErr = await logoutRes.text().catch(() => '');
    await logError('admin/revoke-user', 'logout_failed', { status: logoutRes.status, body: logoutErr.slice(0, 300), userId, email });
  }

  return res.status(200).json({
    ok: banOk && logoutOk,
    user_id: userId,
    email: target.email,
    banned: banOk,
    sessions_revoked: logoutOk,
    banErr: banErr ? banErr.slice(0, 200) : null,
    logoutErr: logoutErr ? logoutErr.slice(0, 200) : null,
    last_sign_in_at: target.last_sign_in_at || null,
    user_created_at: target.created_at || null
  });
}
