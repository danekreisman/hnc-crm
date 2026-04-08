import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function daysUntilDue(terms) {
  if (!terms || terms === 'Due now' || terms === 'net0') return 0;
  const match = String(terms).match(/(\d+)/);
  return match ? parseInt(match[1]) : 30;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { customerName, customerEmail, amount, service, terms, notes } = req.body;

  if (!customerEmail || !amount) {
    return res.status(400).json({ error: 'customerEmail and amount are required' });
  }

  const amountCents = Math.round(parseFloat(String(amount).replace(/[^0-9.]/g, '')) * 100);
  if (!amountCents || amountCents <= 0) {
    return res.status(400).json({ error: 'Invalid amount: ' + amount });
  }

  try {
    let customer;
    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        name: customerName || customerEmail,
        email: customerEmail
      });
    }

    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: amountCents,
      currency: 'usd',
      description: service || 'Cleaning service'
    });

    const due = daysUntilDue(terms);
    const invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: due,
      footer: 'Pay by ACH bank transfer — FREE (3-5 business days). Pay by card — 3% processing fee added. Questions? Email dane@hawaiinaturalclean.com',
      description: notes || undefined,
      metadata: {
        service: service || '',
        terms: terms || 'NET30',
        sent_by: 'dane@hawaiinaturalclean.com'
      }
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(finalized.id);

    return res.status(200).json({
      success: true,
      invoiceId: finalized.id,
      invoiceUrl: finalized.hosted_invoice_url,
      invoicePdf: finalized.invoice_pdf,
      amount: amountCents,
      customer: customer.id
    });
  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
