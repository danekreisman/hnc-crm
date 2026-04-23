/**
 * GET /api/unsubscribe?id={leadId}&type=lead
 * GET /api/unsubscribe?id={clientId}&type=client
 *
 * Called when a recipient clicks the unsubscribe link in any HNC email.
 * Sets unsubscribed_at on the matching leads/clients record.
 * Returns a clean HTML confirmation page — no JSON, this is a browser request.
 *
 * The id is a UUID (hard to guess). type defaults to 'lead' if omitted.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

const BRAND_COLOR = '#3BB8E3';
const BUSINESS    = 'Hawaii Natural Clean';

function renderPage(heading, body, isError = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${heading} · ${BUSINESS}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
           background: #f8fafc; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; padding: 24px; }
    .card { background: #fff; border-radius: 16px; padding: 48px 40px; max-width: 480px;
            width: 100%; text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,.06); }
    .icon { font-size: 48px; margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 12px; }
    p { font-size: 15px; line-height: 1.6; color: #64748b; margin-bottom: 16px; }
    a { color: ${BRAND_COLOR}; text-decoration: none; font-weight: 500; }
    .logo { display: block; margin: 0 auto 32px; height: 40px; width: auto; }
  </style>
</head>
<body>
  <div class="card">
    <img src="https://hnc-crm.vercel.app/hnc-logo.png" alt="${BUSINESS}" class="logo">
    <div class="icon">${isError ? '⚠️' : '✅'}</div>
    <h1>${heading}</h1>
    ${body}
    <p style="margin-top:28px;font-size:13px;">
      <a href="https://hawaiinaturalclean.com">${BUSINESS}</a>
    </p>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Only GET — this is a browser link click, not an API call
  if (req.method !== 'GET') return res.status(405).end();

  const { id, type = 'lead' } = req.query || {};

  if (!id || !['lead', 'client'].includes(type)) {
    return res.status(400).send(renderPage(
      'Invalid link',
      '<p>This unsubscribe link is invalid or has expired. Please contact us directly.</p>',
      true
    ));
  }

  try {
    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const table = type === 'client' ? 'clients' : 'leads';

    // Check if record exists first
    const { data: record } = await db
      .from(table)
      .select('id, name, unsubscribed_at')
      .eq('id', id)
      .maybeSingle();

    if (!record) {
      return res.status(404).send(renderPage(
        'Link not found',
        '<p>We couldn\'t find your record. You may already be unsubscribed, or the link is outdated.</p>',
        true
      ));
    }

    // Already unsubscribed — idempotent, show success anyway
    if (record.unsubscribed_at) {
      return res.status(200).send(renderPage(
        'Already unsubscribed',
        `<p>You're already off our list. You won't receive any more marketing emails from us.</p>
         <p>If you believe this is a mistake, just call or text us at <a href="tel:8084685356">(808) 468-5356</a>.</p>`
      ));
    }

    // Set unsubscribed_at
    const { error } = await db
      .from(table)
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;

    return res.status(200).send(renderPage(
      'You\'ve been unsubscribed',
      `<p>You've been removed from our email list. We're sorry to see you go.</p>
       <p>You won't receive any more marketing emails from ${BUSINESS}. Transactional emails (invoices, receipts, appointment reminders) may still be sent.</p>
       <p>If you change your mind or need anything, we're always reachable at <a href="tel:8084685356">(808) 468-5356</a>.</p>`
    ));

  } catch (err) {
    await logError('unsubscribe', err, { id, type });
    return res.status(500).send(renderPage(
      'Something went wrong',
      '<p>We had trouble processing your request. Please try again or contact us directly.</p>',
      true
    ));
  }
}
