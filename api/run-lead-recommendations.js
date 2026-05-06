/**
 * POST /api/run-lead-recommendations  (Vercel cron — twice daily 8am + 2pm HST)
 *
 * For every open, in-pipeline, non-DNC lead, generates a fresh AI
 * recommendation and writes it to lead_recommendations. Skips leads that
 * already have a fresh (last 12h) pending rec to save tokens — the
 * on-demand refresh endpoint handles material events between cron runs.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';
import { generateRecForLead, isLeadActionable } from './utils/generate-rec.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const stats = {
    examined: 0,
    skipped_not_actionable: 0,
    skipped_fresh_rec: 0,
    generated: 0,
    failed: 0,
  };

  try {
    // 1. Find the active assistant. If none registered, sign as a generic name.
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

    // 2. Pull all open leads
    const { data: leads, error: leadsErr } = await db
      .from('leads')
      .select('id, name, contact_name, phone, email, stage, service, sqft, beds, baths, quote_total, quote_data, notes, quote_sent_at, last_responded_at, do_not_contact, created_at')
      .not('stage', 'in', '("Closed won","Closed lost")');
    if (leadsErr) throw leadsErr;

    const actionableLeads = (leads || []).filter(isLeadActionable);
    stats.skipped_not_actionable = (leads?.length || 0) - actionableLeads.length;

    // 3. Find leads with a pending rec from the last 12h — skip those
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const { data: freshRecs } = await db
      .from('lead_recommendations')
      .select('lead_id')
      .eq('status', 'pending')
      .gte('generated_at', twelveHoursAgo);
    const freshLeadIds = new Set((freshRecs || []).map(r => r.lead_id));

    // 4. Generate recs for the rest, with concurrency cap to avoid rate limits
    const toProcess = actionableLeads.filter(l => !freshLeadIds.has(l.id));
    stats.skipped_fresh_rec = actionableLeads.length - toProcess.length;
    stats.examined = toProcess.length;

    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker() {
      while (cursor < toProcess.length) {
        const i = cursor++;
        const lead = toProcess[i];
        try {
          const rec = await generateRecForLead(db, lead, { assistantName });
          if (rec) stats.generated++;
        } catch (e) {
          stats.failed++;
          console.warn('[run-lead-recommendations] failed for', lead.id, e.message);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    console.error('[run-lead-recommendations] err:', err);
    try { await logError('run-lead-recommendations', err.message || String(err), {}); } catch (_e) {}
    return res.status(500).json({ error: err.message || String(err), stats });
  }
}
