// /api/manual-send-invoice-sms
//
// Resends the client's most recent invoice via SMS. We can't make
// Stripe send an SMS (Stripe is email-only), so this fetches the
// invoice's hosted_invoice_url and texts it directly via OpenPhone.
//
// Selection logic mirrors manual-send-invoice-email: most recent
// unpaid first; else most recent overall.

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';
import { logActivity } from './utils/log-activity.js';

const BASE_URL = 'https://hnc-crm.vercel.app';
const BUSINESS_NAME = 'Hawaii Natural Clean';

function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^0-9+]/g, '');
  return '+1' + s.replace(/\D/g, '');
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

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendInvoiceSms);
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
      .select('id, name, phone')
      .eq('id', clientId)
      .maybeSingle();
    if (clErr) throw clErr;
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.phone) {
      return res.status(400).json({
        error: 'Client has no phone on file. Add a phone before resending the invoice via SMS.',
      });
    }

    // Same selection as the email path — most recent unpaid first,
    // else most recent overall. Requires stripe_invoice_id since we
    // need to fetch the hosted URL from Stripe.
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
    let hostedUrl = null;
    let totalDue = invoice.total;
    try {
      const invObj = await stripe.invoices.retrieve(invoice.stripe_invoice_id);
      hostedUrl = invObj && invObj.hosted_invoice_url;
      // Prefer Stripe's number for the dollar figure (cents → dollars)
      if (invObj && typeof invObj.amount_due === 'number') totalDue = invObj.amount_due / 100;
    } catch (stripeErr) {
      await logError('manual-send-invoice-sms:stripe', stripeErr, {
        clientId, invoiceRowId: invoice.id, stripeInvoiceId: invoice.stripe_invoice_id,
      });
      return res.status(502).json({
        error: 'Could not retrieve invoice from Stripe: ' + (stripeErr.message || 'unknown error'),
      });
    }
    if (!hostedUrl) {
      return res.status(404).json({
        error: 'Stripe returned no hosted URL for this invoice. Send a fresh invoice instead.',
      });
    }

    const firstName = (client.name || 'there').split(' ')[0];
    const totalStr = (totalDue != null && !isNaN(Number(totalDue))) ? `$${Number(totalDue).toFixed(2)}` : null;
    const message = totalStr
      ? `Aloha ${firstName}! Here's your ${BUSINESS_NAME} invoice for ${totalStr}: ${hostedUrl} Mahalo!`
      : `Aloha ${firstName}! Here's your ${BUSINESS_NAME} invoice: ${hostedUrl} Mahalo!`;
    const phoneE164 = toE164(client.phone);

    const sendRes = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phoneE164, message }),
    }, TIMEOUTS.OPENPHONE);

    if (!sendRes.ok) {
      const body = await sendRes.text().catch(() => '<unreadable>');
      await logError('manual-send-invoice-sms', new Error('send-sms ' + sendRes.status), {
        clientId, status: sendRes.status, body: body.slice(0, 500),
      });
      await logActivity(
        'manual_invoice_sms_sent',
        `Invoice SMS to ${client.name || 'client'} failed`,
        { client_id: clientId, channel: 'sms', recipient: phoneE164, body: message },
        { user_email: userEmail, status: 'failed', failure_reason: 'SMS service error ' + sendRes.status },
      );
      return res.status(502).json({ error: 'SMS service rejected the send. See Recent Errors.' });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('clients')
      .update({ invoice_resent_at: sentAt, invoice_resent_by: userId })
      .eq('id', clientId);
    if (updErr) await logError('manual-send-invoice-sms:audit-update', updErr, { clientId });

    await logActivity(
      'manual_invoice_sms_sent',
      `Invoice SMS sent to ${client.name || 'client'}`,
      {
        client_id: clientId,
        channel: 'sms',
        recipient: phoneE164,
        invoiceRowId: invoice.id,
        stripeInvoiceId: invoice.stripe_invoice_id,
        invoiceTotal: totalDue,
        sentBy: userId,
        body: message,
      },
      { user_email: userEmail },
    );

    return res.status(200).json({ success: true, recipient: phoneE164, sentAt, hostedUrl });
  } catch (err) {
    await logError('manual-send-invoice-sms', err, { clientId });
    try {
      await logActivity(
        'manual_invoice_sms_sent',
        'Invoice SMS send failed',
        { client_id: clientId },
        { user_email: 'system', status: 'failed', failure_reason: err.message || 'Unknown error' },
      );
    } catch (_) {}
    return res.status(500).json({ error: 'Could not resend invoice via SMS. See Recent Errors.' });
  }
}
