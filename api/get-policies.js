/**
 * GET /api/get-policies
 * Returns the current policy items for the client-facing agree.html page.
 * Loads from the settings table; falls back to defaults if not yet configured.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

const DEFAULT_POLICIES = [
  { id: 'p1', title: 'Cancellation policy',
    detail: 'Please provide at least 24 hours notice to cancel or reschedule. Late cancellations may incur a fee.' },
  { id: 'p2', title: 'Home preparation',
    detail: 'Please tidy clutter from surfaces, do dishes or put them away, and secure any pets before our team arrives.' },
  { id: 'p3', title: 'Property access',
    detail: 'Please ensure we have access to your property at the scheduled time. You will be asked to provide entry instructions when booking.' },
  { id: 'p4', title: 'Payment terms',
    detail: 'Payment is due on the day of service. We accept ACH bank transfer (free) and credit/debit card (3% processing fee).' },
  { id: 'p5', title: 'Quote accuracy & on-arrival adjustment',
    detail: 'Your quote was based on the property condition you described. If our team arrives and finds the condition is materially worse than described — heavier soil, mold, biohazard, hoarding, post-construction debris, or pet damage — we may adjust the price to reflect the actual scope of work. We will always show you photos and confirm the new quote with you before starting. You may then proceed at the revised price or cancel the appointment (a trip fee may apply). Customers who lock their quote in advance by sending photos of the space are exempt from this adjustment.' },
  { id: 'p6', title: 'I agree to the terms of service',
    detail: 'By proceeding I authorise Hawaii Natural Clean to perform cleaning services and agree to all policies above.' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const { data, error } = await db
      .from('settings')
      .select('value')
      .eq('key', 'policy_items')
      .maybeSingle();

    if (error) throw error;

    const policies = data?.value ? JSON.parse(data.value) : DEFAULT_POLICIES;
    return res.status(200).json({ policies });

  } catch (err) {
    await logError('get-policies', err, {});
    // Fall back to defaults so agree.html never breaks
    return res.status(200).json({ policies: DEFAULT_POLICIES });
  }
}
