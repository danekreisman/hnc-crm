/**
 * POST /api/run-invoice-reminders  (called by Vercel cron, daily at 5am UTC = 7pm HST)
 *
 * Finds clients with invoices that are overdue (due_date < today, status != paid/void)
 * and sends an SMS reminder. Throttled to one reminder per invoice per 3 days
 * using the invoice's last_reminder_at field.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

async function getStripeInvoiceUrl(stripeInvoiceId) {
  if (!stripeInvoiceId) return null;
  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const inv = await stripe.invoices.retrieve(stripeInvoiceId);
    return inv.hosted_invoice_url || null;
  } catch (e) {
    return null; // non-fatal — just skip the link
  }
}

const BASE_URL      = 'https://hnc-crm.vercel.app';
const BUSINESS_NAME = 'Hawaii Natural Clean';
const BUSINESS_PHONE = '(808) 468-5356';


async function isNotifEnabled(db, clientId, key) {
  if (!clientId) return true;
  const { data } = await db.from('clients').select('notification_prefs').eq('id', clientId).maybeSingle();
  const prefs = { booking_confirmation:true, day_before_reminder:true, invoice_reminder:true, policy_reminder:true, post_clean_email:true, review_request:true, ...(data?.notification_prefs || {}) };
  return prefs[key] !== false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Find unpaid invoices older than 7 days, not reminded in last 3 days
    const { data: invoices, error } = await db
      .from('invoices')
      .select(`
        id, amount, total, created_at, status, stripe_invoice_id, last_reminder_at,
        clients ( id, name, phone )
      `)
      .lt('created_at', sevenDaysAgo)
      .not('status', 'in', '("paid","void","cancelled")')
      .or(`last_reminder_at.is.null,last_reminder_at.lt.${threeDaysAgo}`);

    if (error) throw error;
    if (!invoices || invoices.length === 0) {
      return res.status(200).json({ success: true, sent: 0, message: 'No overdue invoices' });
    }

    let sent = 0;
    const errors = [];

    for (const invoice of invoices) {
      const client = invoice.clients;
      if (!client?.phone) continue;

      const firstName = (client.name || 'there').split(' ')[0];
      const phone = client.phone.replace(/\D/g, '');
      const e164  = client.phone.startsWith('+') ? client.phone : `+1${phone}`;
      const amount = invoice.total ? `$${Number(invoice.total).toFixed(2)}` : (invoice.amount ? `$${Number(invoice.amount).toFixed(2)}` : 'your balance');
      const daysOut = Math.floor((Date.now() - new Date(invoice.created_at)) / (1000 * 60 * 60 * 24));

      const invoiceUrl = await getStripeInvoiceUrl(invoice.stripe_invoice_id);
      const payLine = invoiceUrl
        ? `Pay here: ${invoiceUrl}`
        : `Please call or text us at ${BUSINESS_PHONE} to settle your balance.`;

      const message = `Aloha ${firstName}, this is a friendly reminder from ${BUSINESS_NAME}. You have an outstanding invoice of ${amount} that is ${daysOut} days past due. ${payLine} Questions? Call or text ${BUSINESS_PHONE}. Mahalo 🌺`;

      // Check notification prefs
      const clientId = invoice.clients?.id || null;
      const invoiceNotifOn = await isNotifEnabled(db, clientId, 'invoice_reminder');
      if (!invoiceNotifOn) { skipped++; continue; }

      try {
        const resp = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: e164, message }),
        }, TIMEOUTS.OPENPHONE);

        if (resp.ok) {
          // Record reminder timestamp
          await db.from('invoices').update({ last_reminder_at: new Date().toISOString() }).eq('id', invoice.id);
          sent++;
          console.log(`[run-invoice-reminders] Reminded ${client.name} about invoice ${invoice.id}`);
        } else {
          throw new Error(`SMS API returned ${resp.status}`);
        }
      } catch (err) {
        await logError('run-invoice-reminders', err, { invoiceId: invoice.id, clientId: client.id });
        errors.push({ invoiceId: invoice.id, error: err.message });
      }
    }

    return res.status(200).json({ success: true, sent, errors: errors.length ? errors : undefined });

  } catch (err) {
    await logError('run-invoice-reminders', err, {});
    return res.status(500).json({ error: err.message });
  }
}
