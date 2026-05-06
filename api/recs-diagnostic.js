/**
 * GET /api/recs-diagnostic
 *
 * Runs a quick health check on the AI lead recommendations system and
 * returns a JSON report.  Hit this directly in the browser to see:
 *   - Whether the lead_recommendations table exists
 *   - How many recs exist (total, pending, completed, last 24h, last 12h)
 *   - Whether an assistant user is registered
 *   - When the last cron run wrote a row
 *
 * Helps answer "why am I not seeing recommendations?" without poking
 * around in Supabase.
 */

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const report = {
    timestamp: new Date().toISOString(),
    checks: {},
  };

  // 1. Does the table exist? Easiest test: try to count rows.
  try {
    const { count, error } = await db
      .from('lead_recommendations')
      .select('*', { count: 'exact', head: true });
    if (error) {
      report.checks.table_exists = { ok: false, error: error.message, hint: 'Run migration 009_lead_recommendations.sql in Supabase SQL editor' };
    } else {
      report.checks.table_exists = { ok: true, total_rows: count };
    }
  } catch (e) {
    report.checks.table_exists = { ok: false, error: e.message };
  }

  // 2. Recs by status
  if (report.checks.table_exists?.ok) {
    try {
      const { data: byStatus } = await db
        .from('lead_recommendations')
        .select('status')
        .limit(1000);
      const counts = {};
      (byStatus || []).forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
      report.checks.by_status = { ok: true, counts };
    } catch (e) {
      report.checks.by_status = { ok: false, error: e.message };
    }

    // 3. How recent is the most recent rec?
    try {
      const { data: latest } = await db
        .from('lead_recommendations')
        .select('id, lead_id, status, generated_at, action_type')
        .order('generated_at', { ascending: false })
        .limit(5);
      report.checks.most_recent = { ok: true, recs: latest || [] };
      if (latest && latest.length > 0) {
        const newestAge = (Date.now() - new Date(latest[0].generated_at).getTime()) / 36e5;
        report.checks.most_recent.newest_hours_ago = Math.round(newestAge * 10) / 10;
      }
    } catch (e) {
      report.checks.most_recent = { ok: false, error: e.message };
    }

    // 4. Recs created in the last 24h
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count } = await db
        .from('lead_recommendations')
        .select('*', { count: 'exact', head: true })
        .gte('generated_at', dayAgo);
      report.checks.last_24h = { ok: true, count };
    } catch (e) {
      report.checks.last_24h = { ok: false, error: e.message };
    }
  }

  // 5. Is an assistant user configured?
  try {
    const { data: assistants, error } = await db
      .from('app_users')
      .select('id, email, display_name, role, active, invited_at')
      .eq('role', 'assistant');
    if (error) {
      report.checks.assistant_user = { ok: false, error: error.message };
    } else {
      report.checks.assistant_user = {
        ok: true,
        count: assistants?.length || 0,
        users: assistants || [],
      };
    }
  } catch (e) {
    report.checks.assistant_user = { ok: false, error: e.message };
  }

  // 6. Total open leads (denominator for actionable check)
  try {
    const { count } = await db
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .not('stage', 'in', '("Closed won","Closed lost")');
    report.checks.open_leads = { ok: true, count };
  } catch (e) {
    report.checks.open_leads = { ok: false, error: e.message };
  }

  // 7. Anthropic key set? (don't include the value)
  report.checks.anthropic_key_set = !!process.env.ANTHROPIC_API_KEY;

  // 8. Quick verdict
  const verdict = [];
  if (!report.checks.table_exists?.ok) verdict.push('lead_recommendations table is missing — run migration 009');
  if (report.checks.assistant_user?.count === 0) verdict.push('No assistant user — recs will use a generic name');
  if (!report.checks.anthropic_key_set) verdict.push('ANTHROPIC_API_KEY env var is not set on Vercel');
  if (report.checks.last_24h?.count === 0 && report.checks.table_exists?.ok) {
    verdict.push('Zero recs generated in the last 24h — cron may not be running, or all leads were filtered out');
  }
  if (verdict.length === 0) verdict.push('Looks healthy. If recs still not showing, check the assistant role on the logged-in user.');
  report.verdict = verdict;

  return res.status(200).json(report);
}
