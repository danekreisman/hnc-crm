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
          customer = await stripe.customers.create({ name: customerName, email: customerEmail });
        }
      }
      return res.status(200).json({ success: true, customerId: customer.id, customerName: customer.name, email: customer.email });
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
      const days = daysMap[terms] || 0;
      const amountCents = Math.round(parseFloat(amount) * 100);
      await stripe.invoiceItems.create({ customer: customerId2, amount: amountCents, currency: 'usd', description: service || 'Cleaning service' });
      const invoice = await stripe.invoices.create({
        customer: customerId2,
        collection_method: 'send_invoice',
        days_until_due: days,
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
      return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id, status: paymentIntent.status, last4: pm.card.last4 });
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
        description: service || 'Cleaning service'
      });
      return res.status(200).json({ success: true, paymentIntentId: paymentIntent.id, status: paymentIntent.status });
    }

    // ACTION: get_payment_methods
    if (action === 'get_payment_methods') {
      const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
      const bankAccounts = await stripe.paymentMethods.list({ customer: customerId, type: 'us_bank_account' });
      return res.status(200).json({ success: true, cards: cards.data.map(c => ({ id: c.id, last4: c.card.last4, brand: c.card.brand, expMonth: c.card.exp_month, expYear: c.card.exp_year })), bankAccounts: bankAccounts.data.map(b => ({ id: b.id, last4: b.us_bank_account.last4, bankName: b.us_bank_account.bank_name })) });
    }

    // ACTION: create_setup_intent (for saving a card)
    if (action === 'create_setup_intent') {
      const setupIntent = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card', 'us_bank_account'] });
      return res.status(200).json({ success: true, clientSecret: setupIntent.client_secret });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
