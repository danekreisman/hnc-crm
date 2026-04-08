import Stripe from 'stripe';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { customerName, customerEmail, amount, service, terms, notes } = req.body;

    if (!customerEmail || !amount) {
      return res.status(400).json({ success: false, error: 'Email and amount are required' });
    }

    // Find or create customer
    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
    let customer;
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        name: customerName,
        email: customerEmail
      });
    }

    // Calculate due date
    const daysMap = { 'Due now': 0, 'NET15': 15, 'NET30': 30, 'NET45': 45, 'NET60': 60 };
    const days = daysMap[terms] || 0;

    // Create invoice item
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: Math.round(parseFloat(amount) * 100),
      currency: 'usd',
      description: service || 'Cleaning service'
    });

    // Create and send invoice
    const invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: days,
      footer: 'Pay by ACH bank transfer — FREE. Pay by card — 3% processing fee added.',
      description: notes || ''
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(invoice.id);

    return res.status(200).json({
      success: true,
      invoiceId: finalized.id,
      invoiceUrl: finalized.hosted_invoice_url
    });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
