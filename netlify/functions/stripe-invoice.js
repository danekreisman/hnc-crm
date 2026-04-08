const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function daysUntilDue(terms) {
  if (!terms || terms === 'Due now' || terms === 'net0') return 0;
  const match = String(terms).match(/(\d+)/);
  return match ? parseInt(match[1]) : 30;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { customerName, customerEmail, amount, service, terms, notes } = body;

  if (!customerEmail || !amount) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'customerEmail and amount are required' }) };
  }

  // Parse amount — strip $ and commas, convert to cents
  const amountCents = Math.round(parseFloat(String(amount).replace(/[^0-9.]/g, '')) * 100);
  if (!amountCents || amountCents <= 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid amount: ' + amount }) };
  }

  try {
    // 1. Find or create Stripe customer
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

    // 2. Create invoice item
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: amountCents,
      currency: 'usd',
      description: service || 'Cleaning service'
    });

    // 3. Create invoice
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

    // 4. Finalize and send
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(finalized.id);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        invoiceId: finalized.id,
        invoiceUrl: finalized.hosted_invoice_url,
        invoicePdf: finalized.invoice_pdf,
        amount: amountCents,
        customer: customer.id
      })
    };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
