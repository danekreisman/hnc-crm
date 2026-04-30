// ── Idempotency helpers (added 2026-04-30 after duplicate-charge incident) ─────
// Building an idempotency key from a stable prefix + UTC day + a hash of the payload
// guarantees that retries of the SAME logical request within 24h reuse the same Stripe
// resource instead of creating a new one. Different payload OR different day → different
// key → new resource (intended). Stripe expires keys after 24h, which matches our day scope.
function _hncIdempKey(prefix, payload) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const json = JSON.stringify(payload || {});
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = (((h << 5) + h) + json.charCodeAt(i)) | 0; // djb2
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `hnc_${prefix}_${day}_${hex}`;
}
async function _hncIdempCreate(resource, prefix, params) {
  return resource.create(params, { idempotencyKey: _hncIdempKey(prefix, params) });
}

// ── Duplicate-charge guard (added 2026-04-30 — fix 3/5 of Jan Vernon series) ────
// Returns the duplicate invoice row if a 'paid' invoice for the same client + amount
// was created within the last 5 minutes; else null. Fail-open: returns null on any
// error so a Supabase blip can't block legitimate charges (idempotency keys remain
// primary protection against duplicates).
async function _hncRecentDuplicateGuard(stripeCustomerId, amount) {
  try {
    const SB_URL = process.env.SUPABASE_URL;
    const SB_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SB_URL || !SB_SVC || !stripeCustomerId || amount == null) return null;
    const amt = Number(amount);
    if (!isFinite(amt) || amt <= 0) return null;

    const cliRes = await fetch(
      SB_URL + '/rest/v1/clients?select=id&stripe_customer_id=eq.' + encodeURIComponent(stripeCustomerId),
      { headers: { apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC } }
    );
    if (!cliRes.ok) return null;
    const clients = await cliRes.json();
    if (!clients || !clients.length) return null;
    const clientId = clients[0].id;

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const dupRes = await fetch(
      SB_URL + '/rest/v1/invoices?select=id,created_at,total,stripe_payment_intent_id' +
        '&client_id=eq.' + clientId +
        '&total=eq.' + amt +
        '&status=eq.paid' +
        '&created_at=gte.' + encodeURIComponent(fiveMinAgo) +
        '&order=created_at.desc&limit=1',
      { headers: { apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC } }
    );
    if (!dupRes.ok) return null;
    const rows = await dupRes.json();
    return (rows && rows.length) ? rows[0] : null;
  } catch (e) {
    console.error('[stripe-invoice] _hncRecentDuplicateGuard failed:', e && e.message);
    return null;
  }
}

// ── Charge audit + invoice backfill (added 2026-04-30 after Jan Vernon incident) ─
// Every successful Stripe charge writes an immutable audit row to error_logs
// (source='stripe-charge-success') with the payment_intent_id, customer, amount,
// action, and requesting user. Then we best-effort PATCH any matching invoice rows
// that lack stripe_payment_intent_id — so the next incident is reconcilable from
// the database alone, without needing to reconcile by hand against Stripe.
async function _hncRecordCharge(req, paymentIntent) {
  try {
    const SB_URL = process.env.SUPABASE_URL;
    const SB_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SB_URL || !SB_SVC || !paymentIntent) return;
    const customer = paymentIntent.customer || null;
    const amount = (paymentIntent.amount || 0) / 100;
    const piId = paymentIntent.id;
    const userEmail = (req && req.body && req.body._authedEmail) || null;
    const apptId = (req && req.body && (req.body.appointment_id || req.body.appointmentId)) || null;

    fetch(SB_URL + '/rest/v1/error_logs', {
      method: 'POST',
      headers: {
        apikey: SB_SVC,
        Authorization: 'Bearer ' + SB_SVC,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        source: 'stripe-charge-success',
        message: 'charge_succeeded ' + piId,
        context: {
          payment_intent_id: piId,
          stripe_customer_id: customer,
          amount,
          status: paymentIntent.status,
          action: (req && req.body && req.body.action) || null,
          appointment_id: apptId,
          requesting_user_email: userEmail
        }
      })
    }).catch(() => {});

    if (!customer) return;
    try {
      const cliRes = await fetch(
        SB_URL + '/rest/v1/clients?select=id&stripe_customer_id=eq.' + encodeURIComponent(customer),
        { headers: { apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC } }
      );
      if (!cliRes.ok) return;
      const clients = await cliRes.json();
      if (!clients || !clients.length) return;
      const clientId = clients[0].id;
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      await fetch(
        SB_URL + '/rest/v1/invoices?client_id=eq.' + clientId +
          '&total=eq.' + amount +
          '&stripe_payment_intent_id=is.null' +
          '&created_at=gte.' + encodeURIComponent(tenMinAgo),
        {
          method: 'PATCH',
          headers: {
            apikey: SB_SVC,
            Authorization: 'Bearer ' + SB_SVC,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({ stripe_payment_intent_id: piId })
        }
      );
    } catch {
    }
  } catch (e) {
    console.error('[stripe-invoice] _hncRecordCharge failed:', e && e.message);
  }
}
// ────────────────────────────────────────────────────────────────────────────────


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

export default async function handler(req, res) {
  // EMERGENCY KILL SWITCH (added 2026-04-30 after duplicate-charge incident, 4 dupe charges to Jan Vernon).
  // Refuses ALL charge/invoice operations until ALLOW_STRIPE_CHARGES === 'true' is set in Vercel env.
  // Re-enable only after idempotency keys + button-debounce + duplicate guard are deployed.
  if (process.env.ALLOW_STRIPE_CHARGES !== 'true') {
    console.error('[stripe-invoice] BLOCKED by kill switch. Method:', req.method, 'Body keys:', req.body ? Object.keys(req.body) : '(no body)');
    return res.status(503).json({
      error: 'stripe_charges_disabled',
      message: 'Charge creation temporarily disabled. Contact admin.'
    });
  }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.status(200).end();
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
            const Stripe = (await import('stripe')).default;
            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
            const { action, customerName, customerEmail, customerId, amount, service, terms, notes, paymentIntentId, emailSubject, emailBody } = req.body;

          if (action === 'debug_customer') {
                      let cust;
                      if (customerId) {
                                    cust = await stripe.customers.retrieve(customerId);
                      } else if (customerEmail) {
                                    const list = await stripe.customers.list({ email: customerEmail, limit: 1 });
                                    if (list.data.length === 0) return res.status(200).json({ success: true, error: 'no customer found' });
                                    cust = list.data[0];
                      } else {
                                    return res.status(400).json({ error: 'need customerId or customerEmail' });
                      }
                      const pending = await stripe.invoiceItems.list({ customer: cust.id, pending: true, limit: 20 });
                      const invoices = await stripe.invoices.list({ customer: cust.id, limit: 5 });
                      const info = {
                                    keyType: process.env.STRIPE_SECRET_KEY ? (process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : (process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'TEST' : 'UNKNOWN')) : 'NOT SET',
                                    customer: { id: cust.id, email: cust.email, balance: cust.balance, discount: cust.discount, default_source: cust.default_source, tax_exempt: cust.tax_exempt },
                                    pending_items: pending.data.map(i => ({ id: i.id, amount: i.amount, description: i.description, invoice: i.invoice })),
                                    recent_invoices: invoices.data.map(i => ({ id: i.id, status: i.status, amount_due: i.amount_due, amount_paid: i.amount_paid, total: i.total, collection_method: i.collection_method, hosted_invoice_url: i.hosted_invoice_url }))
                      };
                      return res.status(200).json({ success: true, debug: info });
          }

          if (action === 'retrieve_invoice') {
                      const { invoiceId } = req.body;
                      const inv = await stripe.invoices.retrieve(invoiceId);
                      return res.status(200).json({ success: true, invoice: { id: inv.id, status: inv.status, amount_due: inv.amount_due, amount_paid: inv.amount_paid, total: inv.total, subtotal: inv.subtotal, hosted_invoice_url: inv.hosted_invoice_url, collection_method: inv.collection_method, auto_advance: inv.auto_advance, customer: inv.customer, paid: inv.paid } });
          }

          if (action === 'find_or_create_customer') {
                      let customer;
                      if (customerId) {
                                    customer = await stripe.customers.retrieve(customerId);
                      } else {
                                    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
                                    if (existing.data.length > 0) {
                                                    customer = existing.data[0];
                                    } else {
                                                    const newCust = await _hncIdempCreate(stripe.customers, 'cu', { name: customerName, email: customerEmail });
                                                    customer = newCust;
                                    }
                      }
                      return res.status(200).json({ success: true, customerId: customer.id });
          }

          if (action === 'send_invoice') {
                      let customerId2 = customerId;
                      if (!customerId2) {
                                    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
                                    if (existing.data.length > 0) {
                                                    customerId2 = existing.data[0].id;
                                    } else {
                                                    const newCust = await _hncIdempCreate(stripe.customers, 'cu', { name: customerName, email: customerEmail });
                                                    customerId2 = newCust.id;
                                    }
                      }
                      const daysMap = { 'Due now': 0, 'NET15': 15, 'NET30': 30, 'NET45': 45, 'NET60': 60 };
                      const days = daysMap[terms] !== undefined ? daysMap[terms] : 0;
                      const amountCents = Math.round(parseFloat(amount) * 100);

              // Support lineItems array (bulk invoice) in addition to single amount
              const lineItems = Array.isArray(req.body.lineItems) ? req.body.lineItems : null;
              let totalCentsFromLines = 0;
              if (lineItems) {
                for (const li of lineItems) {
                  const liAmtNum = parseFloat(String(li.amount || 0).replace(/[^0-9.-]/g, '')) || 0;
                  totalCentsFromLines += Math.round(liAmtNum * 100);
                }
                if (totalCentsFromLines <= 0) {
                  return res.status(400).json({ success: false, error: 'Bulk invoice total must be greater than $0.' });
                }
              } else {
                if (!amountCents || amountCents <= 0) {
                  return res.status(400).json({ success: false, error: 'Invoice amount must be greater than $0. Got: ' + amount });
                }
              }

              try {
                            const pendingItems = await stripe.invoiceItems.list({ customer: customerId2, pending: true, limit: 100 });
                            for (const item of pendingItems.data) {
                                            await stripe.invoiceItems.del(item.id);
                            }
              } catch (e) {
                            console.warn('[stripe-invoice] Could not clear pending items:', e.message);
              }

              if (lineItems) {
                for (const li of lineItems) {
                  const liAmtNum = parseFloat(String(li.amount || 0).replace(/[^0-9.-]/g, '')) || 0;
                  const liAmtCents = Math.round(liAmtNum * 100);
                  const liDesc = (li.description || 'Cleaning service').toString().slice(0, 500);
                  if (liAmtCents > 0) {
                    await _hncIdempCreate(stripe.invoiceItems, 'ii', {
                      customer: customerId2,
                      amount: liAmtCents,
                      currency: 'usd',
                      description: liDesc
                    });
                  }
                }
                // Tax is included as a line item by the frontend (avoids double-tax).
              } else {
                await _hncIdempCreate(stripe.invoiceItems, 'ii', {
                  customer: customerId2,
                  amount: amountCents,
                  currency: 'usd',
                  description: service || 'Cleaning service'
                });
              }

              const invoice = await _hncIdempCreate(stripe.invoices, 'inv', {
                            customer: customerId2,
                            collection_method: 'send_invoice',
                            days_until_due: (days > 0 ? days : 30),
                            auto_advance: false,
                            pending_invoice_items_behavior: 'include',
                            payment_settings: { payment_method_types: ['card'] },
                            footer: (emailBody || '').trim() || 'Thank you for choosing Hawaii Natural Clean.',
                            description: (emailSubject || notes || '').trim() || 'Cleaning service invoice'
              });

              const finalized = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });

              if (finalized.total === 0 || finalized.status === 'paid') {
                            return res.status(400).json({ success: false, error: 'Invoice finalized as $0 or already paid. Total: ' + finalized.total + ', Status: ' + finalized.status, invoiceId: finalized.id });
              }

              await stripe.invoices.sendInvoice(invoice.id);
                      return res.status(200).json({ success: true, invoiceId: finalized.id, invoiceUrl: finalized.hosted_invoice_url, customerId: customerId2, total: finalized.total, status: finalized.status });
          }

          if (action === 'charge_card') {
                      // Duplicate-charge guard (fix 3/5 — refuse if paid invoice exists for this customer+amount in last 5 min)
                      {
                        const _dup = await _hncRecentDuplicateGuard(req.body && req.body.customerId, req.body && req.body.amount);
                        if (_dup) return res.status(409).json({
                          error: 'duplicate_charge_blocked',
                          message: 'A paid invoice for this customer and amount already exists from the last 5 minutes.',
                          existing_invoice_id: _dup.id,
                          existing_payment_intent_id: _dup.stripe_payment_intent_id || null,
                          existing_created_at: _dup.created_at
                        });
                      }
                      const amountCents = Math.round(parseFloat(amount) * 100);
                      const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
                      if (paymentMethods.data.length === 0) {
                                    return res.status(400).json({ success: false, error: 'No card on file for this customer' });
                      }
                      const pm = paymentMethods.data[0];
                      const paymentIntent = await _hncIdempCreate(stripe.paymentIntents, 'pi', {
                                    amount: amountCents,
                                    currency: 'usd',
                                    customer: customerId,
                                    payment_method: pm.id,
                                    confirm: true,
                                    off_session: true,
                                    description: service || 'Cleaning service',
                                    metadata: { customerName, service }
                      });
                      await _hncRecordCharge(req, paymentIntent);
                      return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id, status: paymentIntent.status });
          }

          if (action === 'charge_specific_card') {
                      // Duplicate-charge guard (fix 3/5 — refuse if paid invoice exists for this customer+amount in last 5 min)
                      {
                        const _dup = await _hncRecentDuplicateGuard(req.body && req.body.customerId, req.body && req.body.amount);
                        if (_dup) return res.status(409).json({
                          error: 'duplicate_charge_blocked',
                          message: 'A paid invoice for this customer and amount already exists from the last 5 minutes.',
                          existing_invoice_id: _dup.id,
                          existing_payment_intent_id: _dup.stripe_payment_intent_id || null,
                          existing_created_at: _dup.created_at
                        });
                      }
                      const { paymentMethodId } = req.body;
                      const amountCents = Math.round(parseFloat(amount) * 100);
                      const paymentIntent = await _hncIdempCreate(stripe.paymentIntents, 'pi', {
                                    amount: amountCents,
                                    currency: 'usd',
                                    customer: customerId,
                                    payment_method: paymentMethodId,
                                    confirm: true,
                                    off_session: true,
                                    description: service || 'Cleaning service',
                                    metadata: { customerName, service }
                      });
                      await _hncRecordCharge(req, paymentIntent);
                      return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id, status: paymentIntent.status });
          }

          if (action === 'get_payment_methods') {
                      const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
                      return res.status(200).json({ success: true, cards: cards.data });
          }

          if (action === 'create_setup_intent') {
                      const setupIntent = await _hncIdempCreate(stripe.setupIntents, 'si', { customer: customerId, payment_method_types: ['card'] });
                      return res.status(200).json({ success: true, clientSecret: setupIntent.client_secret });
          }

          if (action === 'stripe_status_check') {
      const k = process.env.STRIPE_SECRET_KEY || '';
      const keyType = k.startsWith('sk_live_') ? 'LIVE' : (k.startsWith('sk_test_') ? 'TEST' : null);
      return res.status(200).json({ success: true, connected: !!keyType, keyType });
    }
    if (action === 'find_customer_cards') {
      const email = (req.body.customerEmail || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ success: false, error: 'customerEmail required' });
      try {
        const list = await stripe.customers.list({ email, limit: 1 });
        if (!list.data.length) return res.status(200).json({ success: true, customerId: null, cards: [] });
        const cust = list.data[0];
        const cards = await stripe.paymentMethods.list({ customer: cust.id, type: 'card' });
        return res.status(200).json({ success: true, customerId: cust.id, cards: cards.data });
      } catch (e) {
        return res.status(200).json({ success: false, customerId: null, cards: [], error: e.message });
      }
    }
    
  // Void invoice
  if (action === 'void_invoice') {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });
    const voidRes = await stripe.invoices.voidInvoice(invoiceId);
    return res.status(200).json({ success: true, status: voidRes.status });
  }

  // Diagnostic: if we got here, the action wasn't recognized. Log what was sent
  // so any future occurrences are easy to investigate.
  console.error('[stripe-invoice] Unknown action received. Body keys:',
    Object.keys(req.body || {}),
    '· action value:', JSON.stringify(action),
    '· content-type:', req.headers['content-type']);
  return res.status(400).json({ error: 'Unknown action', received_action: action || null });
  } catch (err) {
            console.error('[stripe-invoice] Error:', err);
            return res.status(500).json({ error: err.message });
  }
}
