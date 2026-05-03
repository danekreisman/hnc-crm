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


// -- Activity Logger ----------------------------------------------------------
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
// -----------------------------------------------------------------------------


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

    // ── Tipping feature (phase 2, 2026-05-03) ───────────────────────────────
    // Stripe Checkout Sessions for tips carry metadata.purpose='tip' plus the
    // appointment_id. On successful completion we increment tip_amount on the
    // appointment row. Idempotency is provided by the existing isWebhookProcessed
    // gate at the top of this handler — re-deliveries of the same event won't
    // double-increment. tip_amount accumulates because a customer may legitimately
    // tip more than once across separate sessions (rare but possible).
    if (eventType === 'checkout.session.completed') {
      const md = (data && data.metadata) || {};
      if (md.purpose === 'tip' && md.appointment_id) {
        const apptId = md.appointment_id;
        const tipDollars = (data.amount_total || 0) / 100;
        const piId = data.payment_intent || null;

        if (tipDollars > 0) {
          // Read current tip_amount, then PATCH the new sum. Two-step is fine
          // here because webhook idempotency upstream prevents duplicate runs.
          try {
            const readRes = await fetch(
              `${SUPABASE_URL}/rest/v1/appointments?select=id,tip_amount&id=eq.${encodeURIComponent(apptId)}`,
              {
                headers: {
                  'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
                  'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
                }
              }
            );
            if (readRes.ok) {
              const rows = await readRes.json();
              const existing = (rows && rows[0] && +rows[0].tip_amount) || 0;
              const newTotal = +(existing + tipDollars).toFixed(2);
              const updRes = await fetch(
                `${SUPABASE_URL}/rest/v1/appointments?id=eq.${encodeURIComponent(apptId)}`,
                {
                  method: 'PATCH',
                  headers: {
                    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                  },
                  body: JSON.stringify({ tip_amount: newTotal })
                }
              );
              if (!updRes.ok) {
                const errTxt = await updRes.text().catch(() => '');
                console.error('[stripe-webhook] tip update failed:', updRes.status, errTxt.slice(0, 200));
              } else {
                console.log('[stripe-webhook] tip recorded: appt=' + apptId + ' +$' + tipDollars + ' total=$' + newTotal);
              }
            } else {
              console.error('[stripe-webhook] tip lookup failed:', readRes.status);
            }
          } catch (tipErr) {
            console.error('[stripe-webhook] tip processing error:', tipErr && tipErr.message);
          }

          // Audit trail — same shape as _hncRecordCharge in stripe-invoice.js
          // so forensic queries against error_logs surface tip events too.
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/error_logs`, {
              method: 'POST',
              headers: {
                apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal'
              },
              body: JSON.stringify({
                source: 'stripe-tip-success',
                message: 'tip_succeeded ' + (data.id || ''),
                context: {
                  checkout_session_id: data.id || null,
                  payment_intent_id: piId,
                  appointment_id: apptId,
                  amount: tipDollars,
                  cleaner_name: md.cleaner_name || null,
                  client_name: md.client_name || null,
                  customer_email: data.customer_details && data.customer_details.email || null
                }
              })
            });
          } catch (auditErr) {
            console.error('[stripe-webhook] tip audit log failed:', auditErr && auditErr.message);
          }

          await logActivity('tip_paid', 'Tip received: $' + tipDollars + ' for ' + apptId, {
            appointmentId: apptId, amount: tipDollars, sessionId: data.id, paymentIntentId: piId
          });
        }
      }
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
