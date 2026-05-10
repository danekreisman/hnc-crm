// /api/manual-send-invoice-email
//
// Resends the client's most recent invoice via email by calling
// Stripe's sendInvoice on the existing invoice id. Stripe re-fires
// the invoice email to the customer using the email Stripe has on
// file for that customer. The hosted_invoice_url on the original
// invoice stays valid — this is a true RE-send, not a duplicate.
//
// Strategy: pick the most recent UNPAID invoice if any (most common
// case is "they didn't pay yet, can you remind?"). If none unpaid,
// fall back to the most recent invoice overall ("they want a copy
// for their records").

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

async function logActivity(action, description, metadata = {}) {
  try {
    await fetch(process.env.SUPABASE_URL + '/rest/v1/activity_logs', {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ action, description, user_email: 'system', entity_type: action, metadata }),
    });
  } catch (_) { /* non-blocking */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHdr = req.headers.authorization || '';
  const tokenStr = authHdr.replace('Bearer ', '').trim();
  if (!tokenStr) return res.status(401).json({ error: 'Unauthorized' });
  const authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + tokenStr, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });
  const authUser = await authCheck.json().catch(() => ({}));
  const userId = authUser?.id || null;
  const userEmail = authUser?.email || 'unknown';

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendInvoiceEmail);
  if (invalid) return res.status(400).json(invalid);
  const { clientId } = req.body;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { data: client, error: clErr } = await db
      .from('clients')
      .select('id, name, email')
      .eq('id', clientId)
      .maybeSingle();
    if (clErr) throw clErr;
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.email) {
      return res.status(400).json({
        error: 'Client has no email on file. Add an email before resending the invoice.',
      });
    }

    // Find the invoice to resend. Prefer most recent UNPAID; else most
    // recent overall. Both filter by client_id and require a Stripe
    // invoice id (we can't re-fire via Stripe without one).
    let invoice = null;
    {
      const { data: unpaid, error: u1Err } = await db
        .from('invoices')
        .select('id, stripe_invoice_id, status, total, created_at')
        .eq('client_id', clientId)
        .neq('status', 'paid')
        .neq('status', 'Paid')
        .neq('status', 'Void')
        .neq('status', 'void')
        .not('stripe_invoice_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      if (u1Err) throw u1Err;
      invoice = (unpaid && unpaid[0]) || null;
    }
    if (!invoice) {
      const { data: any, error: anyErr } = await db
        .from('invoices')
        .select('id, stripe_invoice_id, status, total, created_at')
        .eq('client_id', clientId)
        .not('stripe_invoice_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      if (anyErr) throw anyErr;
      invoice = (any && any[0]) || null;
    }
    if (!invoice) {
      return res.status(404).json({
        error: 'No previous invoice found for this client. Send one first via the Send invoice button.',
      });
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });
    let invObj;
    try {
      // sendInvoice fires the standard Stripe invoice email. If the
      // invoice is already paid or void Stripe rejects it, we surface
      // the error.
      invObj = await stripe.invoices.sendInvoice(invoice.stripe_invoice_id);
    } catch (stripeErr) {
      await logError('manual-send-invoice-email:stripe', stripeErr, {
        clientId, invoiceRowId: invoice.id, stripeInvoiceId: invoice.stripe_invoice_id,
      });
      return res.status(502).json({
        error: 'Stripe rejected the resend: ' + (stripeErr.message || 'unknown error'),
      });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('clients')
      .update({ invoice_resent_at: sentAt, invoice_resent_by: userId })
      .eq('id', clientId);
    if (updErr) await logError('manual-send-invoice-email:audit-update', updErr, { clientId });

    await logActivity(
      'manual_invoice_resent',
      `${userEmail} resent invoice email to ${client.name || 'client'}`,
      {
        clientId,
        channel: 'email',
        recipient: client.email,
        invoiceRowId: invoice.id,
        stripeInvoiceId: invoice.stripe_invoice_id,
        invoiceTotal: invoice.total,
        sentBy: userId,
      },
    );

    return res.status(200).json({
      success: true,
      recipient: client.email,
      sentAt,
      invoiceUrl: invObj && invObj.hosted_invoice_url ? invObj.hosted_invoice_url : null,
    });
  } catch (err) {
    await logError('manual-send-invoice-email', err, { clientId });
    return res.status(500).json({ error: 'Could not resend invoice email. See Recent Errors.' });
  }
}
