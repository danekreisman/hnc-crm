// /api/utils/send-push.js
//
// Helper for sending Web Push notifications to one or more authenticated
// users. Uses the standard Web Push protocol with VAPID authentication.
//
// Env vars required:
//   - VAPID_PUBLIC_KEY  (also exposed to the frontend for subscription)
//   - VAPID_PRIVATE_KEY (server only, never exposed)
//   - VAPID_SUBJECT     (a 'mailto:owner@example.com' or URL identifying us)
//   - SUPABASE_SERVICE_ROLE_KEY (to read subscriptions bypassing RLS)
//
// Usage:
//   import { sendPushToUsers } from './utils/send-push.js';
//   await sendPushToUsers(['<user_uuid>'], {
//     title: 'Lead replied',
//     body: 'Sharon Lee said "we ended up choosing another company"',
//     url: '/#tasks',
//     tag: 'review-' + leadId,  // dedupe key
//   });
//
// Or by role (admin / cleaner / va):
//   await sendPushToRoles(['admin', 'va'], { ... });

import webpush from 'web-push';

const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';

let vapidConfigured = false;
function ensureVapidConfigured() {
  if (vapidConfigured) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:dane@hawaiinaturalclean.net';
  if (!pub || !priv) {
    throw new Error('VAPID keys not configured (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY)');
  }
  webpush.setVapidDetails(subject, pub, priv);
  vapidConfigured = true;
}

async function _supaFetch(path, opts = {}) {
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SR,
      'Authorization': 'Bearer ' + SR,
      ...(opts.headers || {}),
    },
  });
}

/**
 * Send a push notification to a list of user IDs. Looks up each user's
 * subscriptions, fires the push to each one, and prunes dead subscriptions
 * (410/404 from the push service means the user uninstalled or revoked).
 *
 * Returns: { sent: N, removed: M, errors: [...] }
 */
export async function sendPushToUsers(userIds, payload) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { sent: 0, removed: 0, errors: [] };
  }
  ensureVapidConfigured();

  // Fetch all subscriptions for these users
  const inList = userIds.map((id) => '"' + id + '"').join(',');
  const subsRes = await _supaFetch(
    '/rest/v1/user_push_subscriptions?user_id=in.(' + encodeURIComponent(inList) + ')&select=*'
  );
  if (!subsRes.ok) {
    return { sent: 0, removed: 0, errors: ['subscription lookup failed: ' + subsRes.status] };
  }
  const subs = await subsRes.json();
  if (!Array.isArray(subs) || subs.length === 0) {
    return { sent: 0, removed: 0, errors: [] };
  }

  const json = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;
  const errors = [];
  const deadEndpoints = [];

  await Promise.all(subs.map(async (s) => {
    const sub = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh_key, auth: s.auth_key },
    };
    try {
      await webpush.sendNotification(sub, json, {
        TTL: 60 * 60 * 24,  // 24h — if user is offline longer, drop it
        urgency: payload.urgency || 'normal',
      });
      sent++;
      // Update last_used_at fire-and-forget
      _supaFetch('/rest/v1/user_push_subscriptions?id=eq.' + s.id, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      }).catch(() => {});
    } catch (err) {
      // 410 Gone or 404 = subscription is dead, remove it
      const status = err.statusCode || err.status;
      if (status === 410 || status === 404) {
        deadEndpoints.push(s.endpoint);
      } else {
        errors.push('push failed for ' + s.id + ': ' + (err.message || status));
      }
    }
  }));

  // Bulk-delete dead subscriptions
  if (deadEndpoints.length > 0) {
    try {
      const inEp = deadEndpoints.map((e) => '"' + e.replace(/"/g, '\\"') + '"').join(',');
      const r = await _supaFetch(
        '/rest/v1/user_push_subscriptions?endpoint=in.(' + encodeURIComponent(inEp) + ')',
        { method: 'DELETE' }
      );
      if (r.ok) removed = deadEndpoints.length;
    } catch (e) {
      errors.push('cleanup failed: ' + e.message);
    }
  }

  return { sent, removed, errors };
}

/**
 * Send a push to all users with one of the given roles (admin, va, cleaner).
 * Resolves roles by checking auth.users.user_metadata or a profiles table.
 *
 * For now we look at user_metadata.role on auth.users, which matches the
 * pattern used elsewhere in this codebase. If you later add a profiles
 * table this can be extended.
 */
export async function sendPushToRoles(roles, payload) {
  if (!Array.isArray(roles) || roles.length === 0) return { sent: 0, removed: 0, errors: [] };
  // Look up users with matching role. Auth admin endpoint requires service role.
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users?per_page=200', {
    headers: { 'apikey': SR, 'Authorization': 'Bearer ' + SR },
  });
  if (!r.ok) {
    return { sent: 0, removed: 0, errors: ['user list failed: ' + r.status] };
  }
  const data = await r.json();
  const users = (data.users || []);
  const targetIds = users
    .filter((u) => {
      const meta = u.user_metadata || u.raw_user_meta_data || {};
      const userRole = meta.role || meta.user_role;
      return userRole && roles.includes(String(userRole).toLowerCase());
    })
    .map((u) => u.id);
  if (targetIds.length === 0) return { sent: 0, removed: 0, errors: ['no users with role(s): ' + roles.join(', ')] };
  return sendPushToUsers(targetIds, payload);
}

/**
 * Convenience: send to ALL authenticated users with at least one push
 * subscription. Useful for org-wide alerts in a small business where
 * everyone wants to know about everything.
 */
export async function sendPushToAllSubscribed(payload) {
  ensureVapidConfigured();
  const r = await _supaFetch('/rest/v1/user_push_subscriptions?select=user_id');
  if (!r.ok) return { sent: 0, removed: 0, errors: ['fetch failed: ' + r.status] };
  const rows = await r.json();
  const ids = [...new Set((rows || []).map((s) => s.user_id))];
  return sendPushToUsers(ids, payload);
}
