/**
 * Stripe Webhook Handler
 * Processes Stripe events with idempotency to prevent duplicate processing
 */

import { isWebhookProcessed, recordWebhook } from './utils/webhook-idempotency.js';
import { sendPushToAllSubscribed } from './utils/send-push.js';
import { logActivity } from './utils/log-activity.js';
import Stripe from 'stripe';

// Helper to look up our internal client_id from a Stripe customer id.
// Used by activity logs so charge_succeeded rows attribute to the
// right client's Activity feed. Returns null if no match — webhook
// still proceeds, the activity row just won't deep-link.
async function clientIdForStripeCustomer(stripeCustomerId, supabaseUrl, supabaseKey) {
  if (!stripeCustomerId) return null;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/clients?select=id&stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}&limit=1`, {
      headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey },
    });
    const arr = await r.json();
    return Array.isArray(arr) && arr[0] ? arr[0].id : null;
  } catch (_) { return null; }
}


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
      // Resolve our internal client_id from Stripe's customer id so the
      // activity_log row attributes correctly to the per-client feed.
      const clientId = await clientIdForStripeCustomer(data.customer, SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const amountDollars = data.amount ? (data.amount / 100) : 0;
      const customerName = (data.billing_details && data.billing_details.name) || (data.metadata && data.metadata.client_name) || null;

      // Always log the charge — even when there's no associated invoice
      // (one-off charges fired from the unified Charge modal don't carry
      // an invoice id). The existing 'invoice_paid' log path only fires
      // when data.invoice is present.
      await logActivity(
        'stripe_charge_succeeded',
        `Card charged $${amountDollars.toFixed(2)}${customerName ? ' — ' + customerName : ''}`,
        {
          client_id: clientId,
          chargeId: data.id,
          invoiceId: data.invoice || null,
          paymentIntentId: data.payment_intent || null,
          amount: amountDollars,
          customerName,
          stripeCustomerId: data.customer || null,
        }
      );

      // Update invoice payment status if charge was tied to an invoice
      if (data.invoice) {
        await supabaseUpsert('invoices', {
          stripe_invoice_id: data.invoice,
          stripe_charge_id: data.id,
          payment_status: 'paid',
          paid_at: new Date(data.created * 1000).toISOString()
        }, 'stripe_invoice_id');
        await logActivity(
          'invoice_paid',
          `Invoice paid via Stripe — $${amountDollars.toFixed(2)}`,
          {
            client_id: clientId,
            chargeId: data.id,
            invoiceId: data.invoice,
            amount: amountDollars.toFixed(2),
            customerName,
          }
        );
        // In-app notification (phase 1 of notification system, 2026-05-03).
        // Broadcast to all admins (target_email null). Best-effort — failure
        // here doesn't roll back the payment processing.
        try {
          var customerLabel = customerName || 'a client';
          await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: 'POST',
            headers: {
              apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              event_type: 'invoice_paid',
              title: 'Invoice paid: $' + amountDollars.toFixed(2),
              body: 'Payment received from ' + customerLabel,
              url: '#payments',
              metadata: { chargeId: data.id, invoiceId: data.invoice, amount: amountDollars, client_id: clientId }
            })
          });
          // Phase 2 (push, 2026-05-03): fan out to every subscribed device so
          // the alert reaches Dane's phone home screen even when CRM is closed.
          // Best-effort. Errors logged but don't block the webhook response.
          sendPushToAllSubscribed({
            title: 'Invoice paid: $' + amountDollars.toFixed(2),
            body: 'Payment received from ' + customerLabel,
            url: '/#payments',
            tag: 'invoice-' + data.id,
            urgency: 'high'
          }).catch(function(e){ console.warn('[stripe-webhook] invoice_paid push failed:', e && e.message); });

          // Phase 3b SMS layer (2026-05-03): for high-value invoices, ALSO
          // send an SMS to the owner's business line. Threshold is configurable
          // via env var SMS_INVOICE_THRESHOLD (default $500). Below threshold,
          // push + in-app are sufficient — SMS adds noise. Above threshold,
          // owner wants the redundancy across all channels.
          // Best-effort. SMS failure does not block webhook response.
          var smsThreshold = parseFloat(process.env.SMS_INVOICE_THRESHOLD || '500');
          if (amountDollars >= smsThreshold) {
            var ownerPhone = process.env.OWNER_PHONE || '+18084685356';
            var smsBody = 'HNC: Invoice paid $' + amountDollars.toFixed(2) + ' from ' + customerLabel + '. View: hnc-crm.vercel.app/#payments';
            // Use VERCEL_URL only as last resort — see prior session note about
            // VERCEL_URL returning the deployment-protection wrapper. BASE_URL
            // is the safer default for inter-function calls.
            var smsBase = process.env.BASE_URL || 'https://book.hawaiinaturalclean.com';
            fetch(smsBase + '/api/send-sms', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: ownerPhone, message: smsBody })
            }).then(function(r){
              if (!r.ok) console.warn('[stripe-webhook] high-value SMS non-OK:', r.status);
              else console.log('[stripe-webhook] high-value SMS sent ($' + amountDollars.toFixed(2) + ')');
            }).catch(function(e){ console.warn('[stripe-webhook] high-value SMS failed:', e && e.message); });
          }
        } catch (notifErr) { console.warn('[stripe-webhook] invoice_paid notify failed:', notifErr && notifErr.message); }
        console.log('[stripe-webhook] Updated invoice status for charge:', data.id);
      }
    }

    if (eventType === 'charge.failed') {
      // Resolve our internal client_id for entity filtering.
      const failedClientId = await clientIdForStripeCustomer(data.customer, SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const failedAmount = data.amount ? (data.amount / 100) : 0;
      const failedReason = data.failure_message || data.outcome?.seller_message || 'Charge failed';
      const failedCustomerName = (data.billing_details && data.billing_details.name) || (data.metadata && data.metadata.client_name) || null;

      // Always log the failure — even when there's no invoice attached.
      // status='failed' triggers the bell + push notification side-effect
      // in logActivity. Dane needs to know about declined cards
      // immediately (his framing: 'How else am I supposed to know that
      // a text did not send or a card got declined?').
      await logActivity(
        'stripe_charge_failed',
        `Card charge failed${failedCustomerName ? ' — ' + failedCustomerName : ''}: ${failedReason}`,
        {
          client_id: failedClientId,
          chargeId: data.id,
          invoiceId: data.invoice || null,
          paymentIntentId: data.payment_intent || null,
          amount: failedAmount,
          customerName: failedCustomerName,
          stripeCustomerId: data.customer || null,
        },
        { status: 'failed', failure_reason: failedReason },
      );

      // Mark invoice as failed (existing behavior)
      if (data.invoice) {
        await supabaseUpsert('invoices', {
          stripe_invoice_id: data.invoice,
          stripe_charge_id: data.id,
          payment_status: 'failed',
          payment_error: failedReason
        }, 'stripe_invoice_id');
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

          // In-app notification (phase 1 of notification system). Tip went to
          // a specific cleaner — admins want to know about it. Best-effort.
          try {
            var clientName = md.client_name || 'a client';
            var cleanerName = md.cleaner_name || 'cleaner';
            await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
              method: 'POST',
              headers: {
                apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal'
              },
              body: JSON.stringify({
                event_type: 'tip_received',
                title: 'Tip received: $' + tipDollars.toFixed(2),
                body: clientName + ' tipped ' + cleanerName,
                url: '#payroll',
                metadata: { appointmentId: apptId, amount: tipDollars, cleanerName: cleanerName }
              })
            });
            // Phase 2 push fan-out (2026-05-03)
            sendPushToAllSubscribed({
              title: 'Tip received: $' + tipDollars.toFixed(2),
              body: clientName + ' tipped ' + cleanerName,
              url: '/#payroll',
              tag: 'tip-' + (data.id || apptId),
              urgency: 'normal'
            }).catch(function(e){ console.warn('[stripe-webhook] tip_received push failed:', e && e.message); });
          } catch (notifErr) { console.warn('[stripe-webhook] tip_received notify failed:', notifErr && notifErr.message); }
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
