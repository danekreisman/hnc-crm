/**
 * GET /api/lead-comms-log?leadId=<uuid>
 *
 * Returns the full outbound communication timeline for a lead, combining:
 *   • lead_comms_log entries (AI follow-ups, future automation/manual sends)
 *   • lead_automation_runs entries (cron-driven automations that fired —
 *     even if disabled now, historical runs are visible)
 *
 * Sorted newest-first. Used by the "Comms log" panel on the lead profile.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth gate (same pattern as /api/tasks, /api/lead-followup-*)
  const _authHdr = req.headers.authorization || '';
  const _token = _authHdr.replace('Bearer ', '').trim();
  if (!_token) return res.status(401).json({ error: 'Unauthorized' });
  const _authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + _token, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!_authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });

  const leadId = req.query.leadId;
  if (!leadId) return res.status(400).json({ error: 'leadId required' });

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Source 1: structured comms log
    let commsRows = [];
    try {
      const { data, error } = await db
        .from('lead_comms_log')
        .select('id, channel, kind, content, subject, status, error_message, source_label, sent_at')
        .eq('lead_id', leadId)
        .order('sent_at', { ascending: false })
        .limit(100);
      if (!error && data) commsRows = data;
      else if (error) console.warn('[lead-comms-log] lead_comms_log read failed (run migration?):', error.message);
    } catch (e) {
      console.warn('[lead-comms-log] lead_comms_log fetch threw:', e.message);
    }

    // Source 2: automation runs (which RULE fired for this lead)
    let runRows = [];
    try {
      const { data, error } = await db
        .from('lead_automation_runs')
        .select('id, automation_id, started_at, completed_at, success, error_message, lead_automations(name)')
        .eq('lead_id', leadId)
        .order('started_at', { ascending: false })
        .limit(50);
      if (!error && data) runRows = data;
    } catch (e) {
      console.warn('[lead-comms-log] lead_automation_runs fetch threw:', e.message);
    }

    // Normalize into a single timeline shape
    const timeline = [];

    for (const r of commsRows) {
      timeline.push({
        kind: r.kind,                     // 'ai_followup' | 'automation' | 'manual' | etc.
        channel: r.channel,               // 'sms' | 'email'
        source_label: r.source_label || (r.kind === 'ai_followup' ? 'AI follow-up' : r.kind),
        content_preview: (r.content || '').slice(0, 200),
        subject: r.subject || null,
        status: r.status,
        error_message: r.error_message,
        timestamp: r.sent_at,
        category: 'comm',
      });
    }

    for (const r of runRows) {
      const ruleName = (r.lead_automations && r.lead_automations.name) || 'Automation';
      timeline.push({
        kind: 'automation_run',
        channel: null,
        source_label: ruleName,
        content_preview: r.success
          ? `Automation rule fired for this lead`
          : (r.error_message ? `Automation failed: ${String(r.error_message).slice(0, 200)}` : 'Automation failed'),
        subject: null,
        status: r.success ? 'sent' : 'failed',
        error_message: r.error_message,
        timestamp: r.started_at,
        category: 'automation',
      });
    }

    // Sort newest first
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return res.status(200).json({
      success: true,
      timeline,
      counts: {
        comms: commsRows.length,
        automations: runRows.length,
      },
    });
  } catch (err) {
    await logError('lead-comms-log', err, { leadId });
    return res.status(500).json({ error: err.message });
  }
}
