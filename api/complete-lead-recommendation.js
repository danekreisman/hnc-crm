/**
 * POST /api/complete-lead-recommendation
 * Body: { recId, action }
 *   action = 'sent' | 'called' | 'skipped'
 *
 * Marks a recommendation as completed and stamps who did it. Used by the
 * Daily list UI after the assistant clicks Send/Call/Skip. Does NOT do the
 * sending itself — for SMS/email the UI calls /api/lead-followup-send first
 * and only hits this endpoint after that succeeds.
 */

import { createClient } from '@supabase/supabase-js';
import { requireAuth } from './utils/auth-check.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const { recId, action, payload } = req.body || {};
  if (!recId) return res.status(400).json({ error: 'recId required' });
  const valid = ['sent', 'called', 'skipped'];
  if (!valid.includes(action)) return res.status(400).json({ error: 'invalid action' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { error } = await db
      .from('lead_recommendations')
      .update({
        status: action === 'skipped' ? 'dismissed' : 'completed',
        completed_at: new Date().toISOString(),
        completed_by_email: user.email || null,
        action_taken: { action, payload: payload || null, by: user.email || null },
      })
      .eq('id', recId)
      .eq('status', 'pending'); // only complete if still pending — protects against double-click races
    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[complete-lead-rec] err:', err);
    try { await logError('complete-lead-recommendation', err.message || String(err), {}); } catch (_e) {}
    return res.status(500).json({ error: err.message || String(err) });
  }
}
