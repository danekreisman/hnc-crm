// api/test-push.js — admin diagnostic endpoint
//
// Sends a test push to the calling user's subscriptions ONLY.
// Returns sent count + per-subscription delivery status so we can
// see exactly which subscription fails and why.
//
// Usage: hit /api/test-push while signed in as admin. No body needed.
//
// Created 2026-05-08 to diagnose 'mobile gets pushes, desktop doesn't'

import { sendPushToUsers } from './utils/send-push.js';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const db = createClient(SUPABASE_URL, SUPABASE_KEY);

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No auth token' });

  const { data: { user }, error: authErr } = await db.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  // Show all subs for this user with last 8 chars of endpoint to identify them
  const { data: subs } = await db
    .from('user_push_subscriptions')
    .select('id, user_agent, endpoint, created_at')
    .eq('user_id', user.id);

  if (!subs || subs.length === 0) {
    return res.status(200).json({ user_id: user.id, error: 'No subscriptions found for this user' });
  }

  const result = await sendPushToUsers([user.id], {
    title: 'Test push — ' + new Date().toLocaleTimeString(),
    body: 'If you see this, push delivery works on this device.',
    url: '/#tasks',
    tag: 'test-push-' + Date.now(),
  });

  // Re-fetch subs to see if any got auto-deleted as 410 Gone
  const { data: subsAfter } = await db
    .from('user_push_subscriptions')
    .select('id, user_agent, endpoint, created_at')
    .eq('user_id', user.id);

  const subsBefore = subs.map(s => ({
    user_agent: s.user_agent,
    endpoint_tail: s.endpoint.slice(-12),
    created_at: s.created_at,
    still_alive_after_send: subsAfter.some(a => a.id === s.id),
  }));

  return res.status(200).json({
    user_id: user.id,
    user_email: user.email,
    subscriptions_before: subsBefore,
    send_result: result,
    note: 'still_alive_after_send=false means push backend got 410/404 from FCM/Apple and deleted that subscription',
  });
}
