// /api/sync-client-cards
//
// Pulls the current set of payment methods Stripe has for this
// customer and persists them to clients.cards. Triggered by the
// per-client "Refresh card data" button. Read-only with respect
// to Stripe — we list payment methods, never modify them.
//
// Resolution order for the Stripe customer:
//   1. clients.stripe_customer_id (preferred — already linked)
//   2. Lookup by email — if Stripe finds a matching customer, also
//      writes the customer ID back to clients.stripe_customer_id
//      so future calls skip the email lookup.
//
// Card array shape: [{id, brand, last4, exp_month, exp_year}]
// Empty array (and cards_synced_at set) = "we asked, none on file."

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout } from './utils/with-timeout.js';
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
  const userEmail = authUser?.email || 'unknown';

  const invalid = validateOrFail(req.body, SCHEMAS.syncClientCards);
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
      .select('id, name, email, stripe_customer_id')
      .eq('id', clientId)
      .maybeSingle();
    if (clErr) throw clErr;
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });

    // Resolve the Stripe customer. Prefer the linked customer ID;
    // fall back to email lookup. If both fail, write empty cards
    // array so the UI knows we checked.
    let customerId = client.stripe_customer_id || null;
    let foundViaEmail = false;
    if (!customerId && client.email) {
      try {
        const search = await stripe.customers.list({ email: client.email.trim().toLowerCase(), limit: 1 });
        if (search.data && search.data.length > 0) {
          customerId = search.data[0].id;
          foundViaEmail = true;
        }
      } catch (searchErr) {
        await logError('sync-client-cards:customer-search', searchErr, { clientId, email: client.email });
      }
    }

    if (!customerId) {
      // No Stripe customer at all — clear the array, mark as synced.
      const syncedAt = new Date().toISOString();
      await db.from('clients').update({ cards: [], cards_synced_at: syncedAt }).eq('id', clientId);
      return res.status(200).json({
        success: true,
        clientId,
        customerId: null,
        cards: [],
        message: 'No Stripe customer found for this client',
      });
    }

    // List payment methods for the customer (cards only).
    let paymentMethods;
    try {
      paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 20 });
    } catch (listErr) {
      await logError('sync-client-cards:list-pms', listErr, { clientId, customerId });
      return res.status(502).json({
        error: 'Stripe rejected the payment-methods list: ' + (listErr.message || 'unknown error'),
      });
    }

    const cards = (paymentMethods.data || []).map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand || 'card',
      last4: pm.card?.last4 || '????',
      exp_month: pm.card?.exp_month || null,
      exp_year:  pm.card?.exp_year  || null,
    }));

    const syncedAt = new Date().toISOString();
    const updatePayload = { cards, cards_synced_at: syncedAt };
    if (foundViaEmail) updatePayload.stripe_customer_id = customerId;

    const { error: updErr } = await db
      .from('clients')
      .update(updatePayload)
      .eq('id', clientId);
    if (updErr) {
      await logError('sync-client-cards:update', updErr, { clientId, customerId });
      return res.status(500).json({ error: 'Could not save card data. See Recent Errors.' });
    }

    await logActivity(
      'sync_client_cards',
      `${userEmail} synced card data for ${client.name || 'client'}: ${cards.length} card(s)`,
      { clientId, customerId, cardCount: cards.length, foundViaEmail },
    );

    return res.status(200).json({
      success: true,
      clientId,
      customerId,
      cards,
      foundViaEmail,
      syncedAt,
    });
  } catch (err) {
    await logError('sync-client-cards', err, { clientId });
    return res.status(500).json({ error: 'Could not sync card data. See Recent Errors.' });
  }
}
