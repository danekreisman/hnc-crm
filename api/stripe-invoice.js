export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const { action, customerName, customerEmail, customerId, amount, service, terms, notes, paymentIntentId } = req.body;

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

          // Clear any stale pending invoice items for this customer before creating new ones
          // This prevents leftover items from failed/duplicate sends from inflating the invoice
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
                        days_until_due: days || 30,
                        auto_advance: false,
                        footer: 'Pay by ACH bank transfer — FREE (3-5 business days). Pay by card — 3% processing fee added.',
                        description: notes || ''
              });
              const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
              await stripe.invoices.sendInvoice(invoice.id);
              return res.status(200).json({ success: true, invoiceId: finalized.id, invoiceUrl: finalized.hosted_invoice_url, customerId: customerId2 });
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
