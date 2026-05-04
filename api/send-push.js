// /api/send-push
//
// Thin authenticated endpoint that fans out a push notification to every
// device subscribed in user_push_subscriptions. Used by the CRM frontend for
// events that fire client-side (booking_created etc.) where the in-app
// notification has already been inserted into the DB and we just need to
// fan out the push.
//
// Server-side events (Stripe webhooks) call sendPushToAllSubscribed directly
// without needing this endpoint — they're already running in the same Vercel
// function context and can import the helper.
//
// Auth: requireAuth (any authenticated CRM user). Notifications are
// broadcast to all subscribed admins — a VA firing a booking_created push
// is normal and expected (they made the booking).
//
// POST body:
//   {
//     title: 'New booking: Jane Doe',
//     body: 'Regular Cleaning on 2026-05-10 at 9am — Maria',
//     url: '/#calendar',
//     tag: 'booking-<id>',     // optional dedupe key
//     urgency: 'normal'        // 'normal' | 'high', controls push urgency header
//   }
//
// Response: { sent, removed, errors } from sendPushToAllSubscribed.

import { requireAuth } from './utils/auth-check.js';
import { sendPushToAllSubscribed } from './utils/send-push.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return; // requireAuth already responded

  const { title, body, url, tag, urgency } = (req.body || {});
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title required' });
  }
  // Title length cap to fit OS notification UI without ellipsis-ing too hard
  const cleanTitle = title.slice(0, 100);
  const cleanBody = (body && typeof body === 'string') ? body.slice(0, 250) : '';
  const cleanUrl = (url && typeof url === 'string') ? url.slice(0, 500) : '/';
  const cleanTag = (tag && typeof tag === 'string') ? tag.slice(0, 80) : undefined;
  const cleanUrgency = urgency === 'high' ? 'high' : 'normal';

  try {
    const result = await sendPushToAllSubscribed({
      title: cleanTitle,
      body: cleanBody,
      url: cleanUrl,
      tag: cleanTag,
      urgency: cleanUrgency
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    await logError('send-push', err, { title: cleanTitle });
    return res.status(500).json({ error: 'send_failed', message: err.message });
  }
}
