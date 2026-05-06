/**
 * POST /api/refresh-lead-recommendation
 * Body: { leadId }
 *
 * Generates a fresh recommendation for one specific lead. Called from:
 *   - The assistant's "Refresh" button on a card
 *   - The lead-realtime watcher when a new reply or stage change happens
 *
 * Auth: any authenticated user (admin, va, or assistant) can trigger.
 */

import { createClient } from '@supabase/supabase-js';
import { requireAuth } from './utils/auth-check.js';
import { generateRecForLead } from './utils/generate-rec.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const { leadId } = req.body || {};
  if (!leadId) return res.status(400).json({ error: 'leadId required' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { data: lead, error: lErr } = await db
      .from('leads')
      .select('id, name, contact_name, phone, email, stage, service, sqft, beds, baths, quote_total, quote_data, notes, quote_sent_at, last_responded_at, do_not_contact, created_at')
      .eq('id', leadId)
      .maybeSingle();
    if (lErr) throw lErr;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Get assistant name
    let assistantName = 'the assistant';
    try {
      const { data: assistantRow } = await db
        .from('app_users')
        .select('display_name, email')
        .eq('role', 'assistant')
        .eq('active', true)
        .order('invited_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (assistantRow) {
        assistantName = assistantRow.display_name || (assistantRow.email || '').split('@')[0] || 'the assistant';
      }
    } catch (_e) {}

    const rec = await generateRecForLead(db, lead, { assistantName });
    if (!rec) {
      return res.status(200).json({ success: true, skipped: true, message: 'Lead not actionable or AI generation failed' });
    }
    return res.status(200).json({ success: true, recommendation: rec });
  } catch (err) {
    console.error('[refresh-lead-rec] err:', err);
    try { await logError('refresh-lead-recommendation', err.message || String(err), {}); } catch (_e) {}
    return res.status(500).json({ error: err.message || String(err) });
  }
}
