export default async function handler(req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.status(200).end();
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
          const Stripe = (await import('stripe')).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const { action, customerName, customerEmail, customerId, amount, service, terms, notes, paymentIntentId } = req.body;

        // ACTION: debug_customer - diagnose invoice issues
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
                  // Get pending invoice items
            const pending = await stripe.invoiceItems.list({ customer: cust.id, pending: true, limit: 20 });
                  // Get recent invoices
            const invoices = await stripe.invoices.list({ customer: cust.id, limit: 5 });
                  // Get key info
            const info = {
                        keyType: process.env.STRIPE_SECRET_KEY ? (process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : (process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'TEST' : 'UNKNOWN')) : 'NOT SET',
                        customer: {
                                      id: cust.id,
                                      email: cust.email,
                                      balance: cust.balance,
                                      discount: cust.discount,
                                      default_source: cust.default_source,
                                      invoice_credit_balance: cust.invoice_credit_balance,
                                      tax_exempt: cust.tax_exempt
                        },
                        pending_items: pending.data.map(i => ({ id: i.id, amount: i.amount, description: i.description, invoice: i.invoice })),
                        recent_invoices: invoices.data.map(i => ({ id: i.id, status: i.status, amount_due: i.amount_due, amount_paid: i.amount_paid, total: i.total, collection_method: i.collection_method, hosted_invoice_url: i.hosted_invoice_url }))
            };
                  return res.status(200).json({ success: true, debug: info });
        }

        // ACTION: retrieve_invoice - check a specific invoice
        if (action === 'retrieve_invoice') {
                  const { invoiceId } = req.body;
                  const inv = await stripe.invoices.retrieve(invoiceId);
                  return res.status(200).json({ success: true, invoice: { id: inv.id, status: inv.status, amount_due: inv.amount_due, amount_paid: inv.amount_paid, total: inv.total, subtotal: inv.subtotal, hosted_invoice_url: inv.hosted_invoice_url, collection_method: inv.collection_method, auto_advance: inv.auto_advance, customer: inv.customer, paid: inv.paid } });
        }

        // ACTION: find_or_create_customer
        if (action === 'find_or_create_customer') {
                  let customer;
                  if (customerId) {
                              customer = await stripe.customers.retrieve(customerId);
                  } else {
                              const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
                              if (existing.data.length > 0) {
                                            customer = existing.data[0];
                              } else {
                                            const newCust = await stripe.customers.create({ name: customerName, email: customerEmail });
                                            customer = newCust;
                              }
                  }
                  return res.status(200).json({ success: true, customerId: customer.id });
        }

        // ACTION: send_invoice
        if (action === 'send_invoice') {
                  let customerId2 = customerId;
                  if (!customerId2) {
                              const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
                              if (existing.data.length > 0) {
                                            customerId2 = existing.data[0].id;
                              } else {
                                            const newCust = await stripe.customers.create({ name: customerName, email: customerEmail });
                                            customerId2 = newCust.id;
                              }
                  }
                  const daysMap = { 'Due now': 0, 'NET15': 15, 'NET30': 30, 'NET45': 45, 'NET60': 60 };
                  const days = daysMap[terms] !== undefined ? daysMap[terms] : 0;
                  const amountCents = Math.round(parseFloat(amount) * 100);

            // Validate amount is not zero
            if (!amountCents || amountCents <= 0) {
                        return res.status(400).json({ success: false, error: 'Invoice amount must be greater than $0. Got: ' + amount });
            }

            // Clear any stale pending invoice items for this customer before creating new ones
            try {
                        const pendingItems = await stripe.invoiceItems.list({ customer: customerId2, pending: true, limit: 100 });
                        for (const item of pendingItems.data) {
                                      await stripe.invoiceItems.del(item.id);
                        }
            } catch (e) {
                        console.warn('[stripe-invoice] Could not clear pending items:', e.message);
            }

            await stripe.invoiceItems.create({ customer: customerId2, amount: amountCents, currency: 'usd', description: service || 'Cleaning service' });
                  const invoice = await stripe.invoices.create({
                              customer: customerId2,
                              collection_method: 'send_invoice',
                              days_until_due: (days > 0 ? days : 30),
                              auto_advance: false,
                              footer: 'Pay by ACH bank transfer — FREE (3-5 business days). Pay by card — 3% processing fee added.',
                              description: notes || ''
                  });
                  const finalized = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
                  // Verify the invoice is not $0 or already paid before sending
            if (finalized.total === 0 || finalized.status === 'paid') {
                        return res.status(400).json({ success: false, error: 'Invoice finalized as $0 or already paid. Check customer balance/credits in Stripe. Total: ' + finalized.total + ', Status: ' + finalized.status, invoiceId: finalized.id });
            }
                  await stripe.invoices.sendInvoice(invoice.id);
                  return res.status(200).json({ success: true, invoiceId: finalized.id, invoiceUrl: finalized.hosted_invoice_url, customerId: customerId2, total: finalized.total, status: finalized.status });
        }

        // ACTION: charge_card
        if (action === 'charge_card') {
                  const amountCents = Math.round(parseFloat(amount) * 100);
                  const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
                  if (paymentMethods.data.length === 0) {
                              return res.status(400).json({ success: false, error: 'No card on file for this customer' });
                  }
                  const pm = paymentMethods.data[0];
                  const paymentIntent = await stripe.paymentIntents.create({
                              amount: amountCents,
                              currency: 'usd',
                              customer: customerId,
                              payment_method: pm.id,
                              confirm: true,
                              off_session: true,
                              description: service || 'Cleaning service',
                              metadata: { customerName, service }
                  });
                  return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id, status: paymentIntent.status });
        }

        // ACTION: charge_specific_card
        if (action === 'charge_specific_card') {
                  const { paymentMethodId } = req.body;
                  const amountCents = Math.round(parseFloat(amount) * 100);
                  const paymentIntent = await stripe.paymentIntents.create({
                              amount: amountCents,
                              currency: 'usd',
                              customer: customerId,
                              payment_method: paymentMethodId,
                              confirm: true,
                              off_session: true,
                              description: service || 'Cleaning service',
                              metadata: { customerName, service }
                  });
                  return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id, status: paymentIntent.status });
        }

        // ACTION: get_payment_methods
        if (action === 'get_payment_methods') {
                  const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
                  return res.status(200).json({ success: true, cards: cards.data });
        }

        // ACTION: create_setup_intent
        if (action === 'create_setup_intent') {
                  const setupIntent = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card'] });
                  return res.status(200).json({ success: true, clientSecret: setupIntent.client_secret });
        }

        return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
          console.error('[stripe-invoice] Error:', err);
          return res.status(500).json({ error: err.message });
  }
}
