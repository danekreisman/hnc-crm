// HNC CRM — /api/generate-tip-link (phase 2 of tipping feature, 2026-05-03)
//
// Admin-only endpoint that returns a signed tip URL for a given appointment.
// Wrapped in requireAdmin so only people on ADMIN_EMAILS can mint tip links.
// The link itself, once issued, is shareable (the client doesn't need to be
// authenticated). This is intentional — clients receive the link via SMS/email
// and follow it from their phones.
//
// Returns: { success, url, expiresAt } so the admin UI can show the URL and
// optionally one-tap copy / send via existing OpenPhone send-sms flows.

import { requireAdmin } from './utils/auth-check.js';
import { generateTipToken } from './utils/tip-token.js';
import { logError } from './utils/error-logger.js';

const BASE_URL = process.env.BASE_URL || 'https://hnc-crm.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Admin gate — same allowlist as Stripe charge endpoints.
  const admin = await requireAdmin(req, res);
  if (!admin) return; // requireAdmin already responded

  const { appointmentId } = (req.body || {});
  if (!appointmentId || typeof appointmentId !== 'string') {
    return res.status(400).json({ error: 'appointmentId required' });
  }

  try {
    const token = generateTipToken(appointmentId);
    const url = BASE_URL + '/tip.html?token=' + encodeURIComponent(token);
    // Decode expiresAt out of the token for the admin UI ("expires in 30 days")
    const exp = parseInt(token.split('.')[1], 10);
    return res.status(200).json({ success: true, url, expiresAt: exp });
  } catch (err) {
    if (err && err.code === 'tip_token_secret_missing') {
      return res.status(500).json({
        error: 'tip_token_secret_missing',
        message: 'TIP_TOKEN_SECRET env var is not configured in Vercel. Generate one with `openssl rand -hex 32` and add it to Production env vars.'
      });
    }
    await logError('generate-tip-link', err, { appointmentId });
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}
