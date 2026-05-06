/**
 * GET /api/get-automations-galaxy
 *
 * Returns one record per automation, each with the structure needed to
 * render it as a "star system" in the galaxy view: trigger info, action
 * sequence (with delays as separate visual nodes), recent runs, and
 * per-automation aggregate stats.
 *
 * Designed to be called once on tab open, then re-polled every ~30s when
 * Live mode is on. Light query: 3 round trips, all bounded.
 *
 * Response:
 *   {
 *     automations: [{
 *       id, name, is_enabled,
 *       trigger: {type, label, config},
 *       steps: [{kind:'trigger'|'delay'|'action'|'exit', label, detail, action_type?, delay_minutes?}],
 *       stats: {total_fires, success, failed, last_fired_at},
 *       recent_runs: [{id, lead_id, lead_name, status, started_at, completed_at, action_count}]
 *     }],
 *     fetched_at: ISO
 *   }
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

const STAGE_LABEL = {
  'New inquiry': 'New inquiry',
  'Quoted': 'Quoted',
  'Walkthrough requested': 'Walkthrough requested',
  'Follow-up': 'Follow-up',
  'Closed won': 'Closed won',
  'Closed lost': 'Closed lost',
};

function _formatDelay(minutes) {
  if (!minutes || minutes <= 0) return 'immediate';
  if (minutes < 60) return minutes + ' min';
  if (minutes < 1440) return Math.round(minutes / 60) + 'h';
  return Math.round(minutes / 1440) + 'd';
}

function _triggerLabel(automation) {
  const t = automation.trigger_type;
  const cfg = automation.trigger_config || {};
  if (t === 'stage_entered') {
    return cfg.stage ? `Lead enters "${cfg.stage}"` : 'Lead enters stage';
  }
  if (t === 'segment_entered') return cfg.segment ? `Enters segment: ${cfg.segment}` : 'Segment entered';
  if (t === 'days_in_segment') return `${cfg.days || '?'} days in ${cfg.segment || 'segment'}`;
  if (t === 'lead_created') return 'Lead created';
  return t || 'Trigger';
}

function _actionLabel(action) {
  if (!action || !action.type) return 'Action';
  switch (action.type) {
    case 'sms':              return 'Send SMS';
    case 'email':            return 'Send Email';
    case 'create_va_task':   return 'Create VA task';
    case 'segment_move':     return 'Move to segment';
    case 'internal_notification': return 'Internal notification';
    default: return action.type;
  }
}

function _actionDetail(action) {
  if (!action) return '';
  if (action.type === 'sms' || action.type === 'email') {
    const m = (action.message || '').trim();
    return m ? (m.length > 90 ? m.slice(0, 88) + '…' : m) : '';
  }
  if (action.type === 'create_va_task') return action.title || '';
  if (action.type === 'segment_move') return action.new_segment || '';
  return '';
}

function _buildSteps(automation) {
  const steps = [];
  // 1. Trigger node
  steps.push({
    kind: 'trigger',
    label: _triggerLabel(automation),
    detail: '',
    icon: 'star',
  });
  // 2. Trigger-level delay (the trigger_config.delay_minutes — distinct from per-action delays)
  const cfg = automation.trigger_config || {};
  if (cfg.delay_minutes && cfg.delay_minutes > 0) {
    steps.push({
      kind: 'delay',
      label: `Wait ${_formatDelay(cfg.delay_minutes)}`,
      detail: '',
      delay_minutes: cfg.delay_minutes,
      icon: 'wait',
    });
  }
  // 3. Action steps
  const actions = automation.actions || [];
  actions.forEach((a, i) => {
    if (a.delay_minutes && a.delay_minutes > 0) {
      steps.push({
        kind: 'delay',
        label: `Wait ${_formatDelay(a.delay_minutes)}`,
        detail: '',
        delay_minutes: a.delay_minutes,
        icon: 'wait',
      });
    }
    steps.push({
      kind: 'action',
      label: _actionLabel(a),
      detail: _actionDetail(a),
      action_type: a.type,
      icon: 'planet',
    });
  });
  // 4. Exit node
  steps.push({
    kind: 'exit',
    label: 'Complete',
    detail: '',
    icon: 'exit',
  });
  return steps;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // 1. All automations
    const { data: automations, error: aErr } = await db
      .from('lead_automations')
      .select('id, name, trigger_type, trigger_config, actions, is_enabled, created_at')
      .order('created_at', { ascending: true });
    if (aErr) throw aErr;

    if (!automations || automations.length === 0) {
      return res.status(200).json({ automations: [], fetched_at: new Date().toISOString() });
    }

    const autoIds = automations.map(a => a.id);

    // 2. Recent runs across all automations (last ~50 per automation = limit 500
    //    total cap; we'll partition client-side in step 3)
    const { data: recentRuns, error: rErr } = await db
      .from('lead_automation_runs')
      .select('id, automation_id, lead_id, status, started_at, completed_at, actions_executed')
      .in('automation_id', autoIds)
      .order('started_at', { ascending: false })
      .limit(500);
    if (rErr) throw rErr;

    // 3. Hydrate lead names for these runs (single query, no N+1)
    const leadIds = Array.from(new Set((recentRuns || []).map(r => r.lead_id).filter(Boolean)));
    let leadById = {};
    if (leadIds.length > 0) {
      const { data: leads } = await db
        .from('leads')
        .select('id, name, contact_name')
        .in('id', leadIds);
      (leads || []).forEach(l => {
        leadById[l.id] = l.name || l.contact_name || 'Lead';
      });
    }

    // 4. Group runs by automation_id, take top 10 per, AND derive aggregate stats
    const runsByAuto = {};
    const statsByAuto = {}; // {autoId: {total, success, failed, last_at}}
    (recentRuns || []).forEach(r => {
      // Stats: count every run we have, regardless of recency cap
      if (!statsByAuto[r.automation_id]) {
        statsByAuto[r.automation_id] = { total: 0, success: 0, failed: 0, last_at: null };
      }
      const s = statsByAuto[r.automation_id];
      s.total++;
      if (r.status === 'success') s.success++;
      else if (r.status === 'failed') s.failed++;
      const ts = r.completed_at || r.started_at;
      if (ts && (!s.last_at || ts > s.last_at)) s.last_at = ts;

      // Recent runs cap: top 10 per automation (preserves ordering since runs
      // are pre-sorted DESC by started_at)
      if (!runsByAuto[r.automation_id]) runsByAuto[r.automation_id] = [];
      if (runsByAuto[r.automation_id].length < 10) {
        const actionCount = Array.isArray(r.actions_executed) ? r.actions_executed.length : 0;
        runsByAuto[r.automation_id].push({
          id: r.id,
          lead_id: r.lead_id,
          lead_name: leadById[r.lead_id] || 'Lead',
          status: r.status,
          started_at: r.started_at,
          completed_at: r.completed_at,
          action_count: actionCount,
        });
      }
    });

    // 5. Compose response
    const result = automations.map(a => {
      const cfg = a.trigger_config || {};
      const s = statsByAuto[a.id] || { total: 0, success: 0, failed: 0, last_at: null };
      return {
        id: a.id,
        name: a.name || 'Untitled',
        is_enabled: !!a.is_enabled,
        trigger: {
          type: a.trigger_type,
          label: _triggerLabel(a),
          stage: cfg.stage || null,
          delay_minutes: cfg.delay_minutes || 0,
        },
        steps: _buildSteps(a),
        stats: {
          total_fires: s.total,
          success: s.success,
          failed: s.failed,
          last_fired_at: s.last_at,
        },
        recent_runs: runsByAuto[a.id] || [],
      };
    });

    return res.status(200).json({
      automations: result,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[get-automations-galaxy] err:', err);
    try { await logError('get-automations-galaxy', err.message || String(err), {}); } catch (_e) {}
    return res.status(500).json({
      error: 'Failed to load galaxy data',
      detail: err.message || String(err),
      code: err.code,
      hint: err.hint,
    });
  }
}
