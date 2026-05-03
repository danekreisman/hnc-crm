// HNC CRM — /api/create-tip-checkout (phase 2 of tipping feature, 2026-05-03)
//
// Public endpoint that creates a Stripe Checkout Session for a tip. Three
// independent gates stack here, in order:
//
//   1. Stripe kill switch (ALLOW_STRIPE_CHARGES) — same env var that gates
//      /api/stripe-invoice. If charges are off site-wide, tipping is off too.
//   2. Tipping test mode — TIP_TEST_MODE env var defaults to 'on' (any value
//      other than 'false'). When on, the endpoint refuses to create a session
//      unless the appointment's client email exactly matches TIP_TEST_EMAIL
//      (default: dane.kreisman@gmail.com). This is enforced server-side after
//      the appointment has been resolved — the client cannot bypass it.
//   3. HMAC token verification via tip-token.js. Without a valid token, the
//      endpoint returns 401 even if all other gates pass.
//
// Stripe Checkout (not direct PaymentIntent) was chosen because:
//   - Stripe-hosted UI handles 3DS, retries, and card errors out of the box
//   - The webhook (checkout.session.completed) is the durable record of "did
//     the tip actually clear" — critical because mobile clients don't always
//     return to our success_url
//   - We don't need a card on file. New cards or saved cards both work via
//     Checkout's own UI.
//
// Idempotency: Stripe's idempotencyKey is keyed on (token, amount_cents, day),
// so a client double-tap returns the same Checkout Session. The webhook also
// adds tip_amount cumulatively, so if the client legitimately tips twice
// (different amounts on different days), both add up.

import Stripe from 'stripe';
import { verifyTipToken } from './utils/tip-token.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Test mode: default ON (Dane only). Production is opted into via env var.
const TIP_TEST_MODE = (process.env.TIP_TEST_MODE || 'on').toLowerCase() !== 'false';
const TIP_TEST_EMAIL = (process.env.TIP_TEST_EMAIL || 'dane.kreisman@gmail.com').toLowerCase();

// Where the customer goes after Stripe Checkout. Tip page handles the result UI.
const BASE_URL = process.env.BASE_URL || 'https://hnc-crm.vercel.app';

// Min/max sanity: $1 floor (Stripe's effective minimum after fees) up to $500
// ceiling (catches typos like "5000" instead of "50.00"). Adjust later if real
// tips exceed this.
const MIN_TIP_DOLLARS = 1;
const MAX_TIP_DOLLARS = 500;

function _idempKey(prefix, payload) {
  // Mirrors _hncIdempKey from stripe-invoice.js. Keep the algorithm identical
  // so retries across endpoints behave the same way.
  const day = new Date().toISOString().slice(0, 10);
  const json = JSON.stringify(payload || {});
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = (((h << 5) + h) + json.charCodeAt(i)) | 0;
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return 'hnc_' + prefix + '_' + day + '_' + hex;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Gate 1: kill switch
  if (process.env.ALLOW_STRIPE_CHARGES !== 'true') {
    return res.status(503).json({
      error: 'stripe_charges_disabled',
      message: 'Tipping is temporarily unavailable. Please try again later.'
    });
  }

  const { token, amount } = (req.body || {});

  // Gate 3 (token first — fail fast on garbage input before any Stripe/Supabase work)
  let v;
  try {
    v = verifyTipToken(token);
  } catch (e) {
    await logError('create-tip-checkout', e, { token_len: (token || '').length });
    return res.status(500).json({ error: 'token_verify_failed' });
  }
  if (!v.valid) {
    return res.status(401).json({ error: 'invalid_token', reason: v.reason });
  }

  // Amount validation
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt < MIN_TIP_DOLLARS || amt > MAX_TIP_DOLLARS) {
    return res.status(400).json({
      error: 'invalid_amount',
      message: 'Tip must be between $' + MIN_TIP_DOLLARS + ' and $' + MAX_TIP_DOLLARS + '.'
    });
  }
  const amountCents = Math.round(amt * 100);

  try {
    // Resolve appointment + client + cleaner names (need them for Checkout
    // line item description and the test-mode email check).
    const apptUrl = SUPABASE_URL +
      '/rest/v1/appointments?select=id,date,service,status,client_id,cleaner_id' +
      '&id=eq.' + encodeURIComponent(v.appointmentId);
    const apptRes = await fetchWithTimeout(apptUrl, {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
    }, TIMEOUTS.SUPABASE);
    if (!apptRes.ok) {
      await logError('create-tip-checkout', new Error('appt lookup failed'), { status: apptRes.status });
      return res.status(502).json({ error: 'lookup_failed' });
    }
    const appts = await apptRes.json();
    if (!appts || !appts.length) {
      return res.status(404).json({ error: 'appointment_not_found' });
    }
    const appt = appts[0];
    if (appt.status === 'deleted' || appt.status === 'cancelled') {
      return res.status(409).json({ error: 'appointment_unavailable', message: 'This appointment is no longer eligible for a tip.' });
    }

    // Client lookup for email + name
    let clientEmail = null;
    let clientName = null;
    if (appt.client_id) {
      const cliRes = await fetchWithTimeout(
        SUPABASE_URL + '/rest/v1/clients?select=id,name,email&id=eq.' + appt.client_id,
        { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } },
        TIMEOUTS.SUPABASE
      );
      if (cliRes.ok) {
        const cli = await cliRes.json();
        if (cli && cli[0]) {
          clientEmail = (cli[0].email || '').toLowerCase().trim() || null;
          clientName = cli[0].name || null;
        }
      }
    }

    // Gate 2: Test mode — Dane only.
    if (TIP_TEST_MODE) {
      if (!clientEmail || clientEmail !== TIP_TEST_EMAIL) {
        return res.status(403).json({
          error: 'test_mode_active',
          message: 'Tipping is currently in test mode. Please contact us directly to leave a tip.'
        });
      }
    }

    // Cleaner name for the line item description
    let cleanerName = 'your cleaner';
    if (appt.cleaner_id) {
      const cRes = await fetchWithTimeout(
        SUPABASE_URL + '/rest/v1/cleaners?select=id,name&id=eq.' + appt.cleaner_id,
        { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } },
        TIMEOUTS.SUPABASE
      );
      if (cRes.ok) {
        const cs = await cRes.json();
        if (cs && cs[0] && cs[0].name) cleanerName = cs[0].name.split(/\s+/)[0];
      }
    }

    // Build the Checkout Session. Metadata is the source of truth that the
    // webhook reads to attribute the tip back to this appointment.
    const idempotencyKey = _idempKey('tipco', { t: token, a: amountCents });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Tip for ' + cleanerName + ' (Hawaii Natural Clean)',
            description: 'Cleaning service on ' + (appt.date || '')
          },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      success_url: BASE_URL + '/tip.html?status=success&token=' + encodeURIComponent(token),
      cancel_url: BASE_URL + '/tip.html?status=cancelled&token=' + encodeURIComponent(token),
      customer_email: clientEmail || undefined,
      metadata: {
        purpose: 'tip',
        appointment_id: v.appointmentId,
        cleaner_name: cleanerName,
        client_name: clientName || ''
      },
      // Mirror metadata onto the underlying PaymentIntent so the audit trail
      // works whether you query by Checkout Session or PaymentIntent.
      payment_intent_data: {
        description: 'Tip for ' + cleanerName + ' — HNC',
        metadata: {
          purpose: 'tip',
          appointment_id: v.appointmentId,
          cleaner_name: cleanerName
        }
      }
    }, { idempotencyKey });

    return res.status(200).json({ success: true, checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    await logError('create-tip-checkout', err, { appointmentId: v.appointmentId, amount: amt });
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}
