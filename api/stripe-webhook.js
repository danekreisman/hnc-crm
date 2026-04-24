/**
 * Stripe Webhook Handler
 * Processes Stripe events with idempotency to prevent duplicate processing
 */

import { isWebhookProcessed, recordWebhook } from './utils/webhook-idempotency.js';
import Stripe from 'stripe';

async function logActivity(action, description, metadata={}) {
  try {
    await fetch(process.env.SUPABASE_URL+'/rest/v1/activity_logs',{
      method:'POST',
      headers:{'apikey':process.env.SUPABASE_SERVICE_ROLE_KEY,'Authorization':'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({action,description,user_email:'system',entity_type:action,metadata})
    });
  } catch(_){}
}


// ── Activity Logger ──────────────────────────────────────────────────────────
async function logActivity(action, description, metadata = {}) {
  try {
    await fetch(process.env.SUPABASE_URL + '/rest/v1/activity_logs', {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ action, description, user_email: 'system', entity_type: action, metadata })
    });
  } catch (_e) { /* non-blocking */ }
}
// ─────────────────────────────────────────────────────────────────────────────


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function supabaseUpsert(table, data, onConflict) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(data)
  });
  return res;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Stripe webhook receiver active' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify Stripe signature (if webhook secret is configured)
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      const body = req.rawBody || JSON.stringify(req.body);
      event = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      // For development without signature verification
      event = req.body;
      console.warn('[stripe-webhook] No webhook secret configured - skipping signature verification');
    }
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Signature verification failed' });
  }

  const eventId = event.id;
  const eventType = event.type;

  try {
    console.log('[stripe-webhook] Processing event:', eventType, 'ID:', eventId);

    // IDEMPOTENCY CHECK
    if (eventId) {
      try {
        const alreadyProcessed = await isWebhookProcessed(eventId, 'stripe', SUPABASE_KEY);
        if (alreadyProcessed) {
          console.log('[stripe-webhook] Event already processed:', eventId);
          return res.status(200).json({ received: true, eventType, alreadyProcessed: true });
        }
      } catch (idempotencyErr) {
        console.error('[stripe-webhook] Idempotency check failed:', idempotencyErr.message);
        return res.status(500).json({ error: 'Idempotency check failed' });
      }
    }

    // Process based on event type
    const data = event.data.object;

    if (eventType === 'charge.succeeded') {
      // Update invoice payment status if charge succeeded
      if (data.invoice) {
        await supabaseUpsert('invoices', {
          stripe_invoice_id: data.invoice,
          stripe_charge_id: data.id,
          payment_status: 'paid',
          paid_at: new Date(data.created * 1000).toISOString()
        }, 'stripe_invoice_id');
        await logActivity('invoice_paid','Invoice paid via Stripe',{chargeId:data.id,invoiceId:data.invoice,amount:data.amount?(data.amount/100).toFixed(2):null});
        console.log('[stripe-webhook] Updated invoice status for charge:', data.id);
      }
    }

    if (eventType === 'charge.failed') {
      // Mark invoice as failed
      if (data.invoice) {
        await supabaseUpsert('invoices', {
          stripe_invoice_id: data.invoice,
          stripe_charge_id: data.id,
          payment_status: 'failed',
          payment_error: data.failure_message || 'Charge failed'
        }, 'stripe_invoice_id');
        await logActivity('charge_failed','Stripe charge failed',{chargeId:data.id,invoiceId:data.invoice});
        console.log('[stripe-webhook] Marked invoice as failed for charge:', data.id);
      }
    }

    if (eventType === 'invoice.payment_succeeded') {
      // Update invoice status
      await supabaseUpsert('invoices', {
        stripe_invoice_id: data.id,
        payment_status: 'paid',
        paid_at: new Date().toISOString()
      }, 'stripe_invoice_id');
      console.log('[stripe-webhook] Invoice payment succeeded:', data.id);
    }

    if (eventType === 'invoice.payment_failed') {
      // Mark invoice payment as failed
      await supabaseUpsert('invoices', {
        stripe_invoice_id: data.id,
        payment_status: 'failed',
        payment_error: data.last_payment_error?.message || 'Payment failed'
      }, 'stripe_invoice_id');
      console.log('[stripe-webhook] Invoice payment failed:', data.id);
    }

    if (eventType === 'customer.deleted') {
      // Mark customer as deleted in Supabase
      // This is optional - adjust based on your needs
      console.log('[stripe-webhook] Customer deleted:', data.id);
    }

    // Record the webhook as processed
    if (eventId) {
      try {
        await recordWebhook(eventId, 'stripe', eventType, event, SUPABASE_KEY);
      } catch (recordErr) {
        console.warn('[stripe-webhook] Failed to record webhook:', recordErr.message);
      }
    }

    return res.status(200).json({ received: true, eventType });

  } catch (err) {
    console.error('[stripe-webhook] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
