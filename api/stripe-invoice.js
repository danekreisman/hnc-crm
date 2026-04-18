export default async function handler(req, res) {
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
                                                    const newCust = await stripe.customers.create({ name: customerName, email: customerEmail });
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
                                                    const newCust = await stripe.customers.create({ name: customerName, email: customerEmail });
                                                    customerId2 = newCust.id;
                                    }
                      }
                      const daysMap = { 'Due now': 0, 'NET15': 15, 'NET30': 30, 'NET45': 45, 'NET60': 60 };
                      const days = daysMap[terms] !== undefined ? daysMap[terms] : 0;
                      const amountCents = Math.round(parseFloat(amount) * 100);

              // Support lineItems array (bulk invoice) in addition to single amount
              const lineItems = Array.isArray(body.lineItems) ? body.lineItems : null;
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
                    await stripe.invoiceItems.create({
                      customer: customerId2,
                      amount: liAmtCents,
                      currency: 'usd',
                      description: liDesc
                    });
                  }
                }
                const taxCents = Math.round(totalCentsFromLines * 0.04);
                if (taxCents > 0) {
                  await stripe.invoiceItems.create({
                    customer: customerId2,
                    amount: taxCents,
                    currency: 'usd',
                    description: 'Hawaii GET tax (4%)'
                  });
                }
              } else {
                await stripe.invoiceItems.create({
                  customer: customerId2,
                  amount: amountCents,
                  currency: 'usd',
                  description: service || 'Cleaning service'
                });
              }

              const invoice = await stripe.invoices.create({
                            customer: customerId2,
                            collection_method: 'send_invoice',
                            days_until_due: (days > 0 ? days : 30),
                            auto_advance: false,
                            pending_invoice_items_behavior: 'include',
                            payment_settings: { payment_method_types: ['card', 'us_bank_account', 'link', 'cashapp'] },
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

          if (action === 'get_payment_methods') {
                      const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
                      return res.status(200).json({ success: true, cards: cards.data });
          }

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
