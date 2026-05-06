/**
 * GET /api/get-automations-flow?days=90
 * Aggregates stage transitions and automation fires into Sankey-graph data.
 *
 * Returns:
 *   {
 *     nodes: [{id, label, type:'source'|'stage'|'automation'|'exit', stage?}],
 *     links: [{source, target, value, kind:'flow'|'fired'}],
 *     stats: {total_leads, total_transitions, total_automation_fires,
 *             range_start, range_end, days, has_enough_data}
 *   }
 *
 * Sources of truth:
 *   - leads: total leads + their entry source (created_at)
 *   - lead_stage_events: every stage transition (occurred_at, to_stage, lead_id)
 *   - lead_automation_runs: every automation fire (completed_at, automation_id, status)
 *   - lead_automations: automation names + trigger config (which stage they hang off)
 *
 * `has_enough_data` is true once there are ≥30 stage transitions in the range
 * — below that the Sankey looks janky (single-lead lines dominate). Frontend
 * shows a soft message when false but still renders.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

const STAGES = ['New inquiry', 'Quoted', 'Walkthrough requested', 'Follow-up', 'Closed won', 'Closed lost'];
const TERMINAL = new Set(['Closed won', 'Closed lost']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 7), 180);
  const rangeStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // Parallel fetch
    const [leadsRes, eventsRes, runsRes, autoRes] = await Promise.all([
      db.from('leads')
        .select('id, source, created_at, stage')
        .gte('created_at', rangeStart.toISOString()),
      db.from('lead_stage_events')
        .select('id, lead_id, to_stage, occurred_at')
        .gte('occurred_at', rangeStart.toISOString())
        .order('occurred_at', { ascending: true }),
      db.from('lead_automation_runs')
        .select('automation_id, lead_id, status, completed_at')
        .gte('completed_at', rangeStart.toISOString())
        .eq('status', 'success'),
      db.from('lead_automations')
        .select('id, name, trigger_type, trigger_config, is_enabled, actions'),
    ]);

    if (leadsRes.error) throw leadsRes.error;
    if (eventsRes.error) throw eventsRes.error;
    if (runsRes.error) throw runsRes.error;
    if (autoRes.error) throw autoRes.error;

    const leads = leadsRes.data || [];
    const events = eventsRes.data || [];
    const runs = runsRes.data || [];
    const automations = autoRes.data || [];

    // ── 1. Build per-lead transition timelines ────────────────────────────
    // Each lead's flow: SOURCE → New inquiry → ... → terminal stage (or
    // current stage if not yet closed).
    const eventsByLead = {};
    for (const ev of events) {
      if (!ev.lead_id || !ev.to_stage) continue;
      if (!eventsByLead[ev.lead_id]) eventsByLead[ev.lead_id] = [];
      eventsByLead[ev.lead_id].push(ev);
    }

    // ── 2. Build flow links: source→stage, stage→stage ────────────────────
    // Aggregate counts per (from, to) pair.
    const flowLinks = new Map();
    const bumpFlow = (from, to) => {
      const k = from + '||' + to;
      flowLinks.set(k, (flowLinks.get(k) || 0) + 1);
    };

    const sourceCounts = new Map();
    let leadsWithFlow = 0;

    for (const lead of leads) {
      const src = (lead.source || 'Unknown').toString().trim() || 'Unknown';
      sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);

      const tl = (eventsByLead[lead.id] || []).slice().sort((a, b) =>
        new Date(a.occurred_at) - new Date(b.occurred_at)
      );

      if (tl.length === 0) {
        // No stage events captured (maybe lead pre-dates Phase 1 trigger).
        // Fall back to source → current stage.
        if (lead.stage) bumpFlow('src::' + src, 'stage::' + lead.stage);
        continue;
      }

      leadsWithFlow++;
      // First event: source → first stage
      bumpFlow('src::' + src, 'stage::' + tl[0].to_stage);
      // Subsequent events: prev stage → next stage
      for (let i = 1; i < tl.length; i++) {
        bumpFlow('stage::' + tl[i - 1].to_stage, 'stage::' + tl[i].to_stage);
      }
    }

    // ── 3. Build automation-fire links: stage → automation ────────────────
    // For each successful run, attribute it to the automation's trigger stage.
    const autoById = new Map(automations.map(a => [a.id, a]));
    const autoFireCounts = new Map(); // key: stage→autoId, value: count
    const autoTotalFires = new Map(); // key: autoId, value: total

    for (const run of runs) {
      const auto = autoById.get(run.automation_id);
      if (!auto) continue;
      autoTotalFires.set(auto.id, (autoTotalFires.get(auto.id) || 0) + 1);
      const cfg = auto.trigger_config || {};
      let originStage = null;
      if (auto.trigger_type === 'stage_entered' && cfg.stage) originStage = cfg.stage;
      // Other trigger types (segment_entered, etc) hang off a virtual "Always
      // running" node so they don't get lost. They're real automations even
      // if their data flow doesn't fit the stage funnel.
      const originId = originStage ? 'stage::' + originStage : 'always::root';
      const k = originId + '||auto::' + auto.id;
      autoFireCounts.set(k, (autoFireCounts.get(k) || 0) + 1);
    }

    // ── 4. Build node + link arrays in Sankey shape ───────────────────────
    const nodes = [];
    const nodeIndex = new Map();
    const addNode = (id, label, type, extra = {}) => {
      if (nodeIndex.has(id)) return nodeIndex.get(id);
      const idx = nodes.length;
      nodeIndex.set(id, idx);
      nodes.push({ id, label, type, ...extra });
      return idx;
    };

    // Sources (entry points)
    const sortedSources = Array.from(sourceCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6); // cap to top 6 sources to keep it readable
    let sourceTotalCapped = 0;
    sortedSources.forEach(([src, n]) => {
      addNode('src::' + src, src, 'source', { count: n });
      sourceTotalCapped += n;
    });
    // Bucket the rest as "Other"
    const otherSources = Array.from(sourceCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(6);
    if (otherSources.length > 0) {
      const otherTotal = otherSources.reduce((s, [, n]) => s + n, 0);
      addNode('src::__other__', 'Other sources', 'source', { count: otherTotal });
    }

    // Stages (in canonical order)
    STAGES.forEach(s => {
      addNode('stage::' + s, s, 'stage', { stage: s });
    });

    // Automations (only those that fired in window OR are enabled)
    const relevantAutos = automations.filter(a =>
      a.is_enabled || (autoTotalFires.get(a.id) || 0) > 0
    );
    relevantAutos.forEach(a => {
      addNode('auto::' + a.id, a.name || 'Automation', 'automation', {
        enabled: !!a.is_enabled,
        fires: autoTotalFires.get(a.id) || 0,
        trigger_type: a.trigger_type,
      });
    });

    // "Always running" virtual node (only if any automations don't have a
    // stage-based trigger AND they fired in window)
    const hasAlwaysAutos = Array.from(autoFireCounts.keys()).some(k => k.startsWith('always::'));
    if (hasAlwaysAutos) {
      addNode('always::root', 'Always running', 'always', {});
    }

    // Build links — only include links where both endpoints are nodes we kept.
    const links = [];
    const otherSrcKeys = new Set(otherSources.map(([s]) => s));

    for (const [k, v] of flowLinks.entries()) {
      const [from, to] = k.split('||');
      let fromKey = from;
      // Reroute small sources into the "Other" bucket
      if (from.startsWith('src::')) {
        const srcName = from.slice(5);
        if (otherSrcKeys.has(srcName)) fromKey = 'src::__other__';
      }
      if (!nodeIndex.has(fromKey) || !nodeIndex.has(to)) continue;
      links.push({
        source: nodeIndex.get(fromKey),
        target: nodeIndex.get(to),
        value: v,
        kind: 'flow',
      });
    }

    // Collapse duplicate links (after the "Other" rerouting)
    const collapsed = new Map();
    for (const l of links) {
      const k = l.source + '||' + l.target + '||' + l.kind;
      if (collapsed.has(k)) collapsed.get(k).value += l.value;
      else collapsed.set(k, { ...l });
    }

    // Automation-fire links
    for (const [k, v] of autoFireCounts.entries()) {
      const [from, to] = k.split('||');
      if (!nodeIndex.has(from) || !nodeIndex.has(to)) continue;
      const ck = nodeIndex.get(from) + '||' + nodeIndex.get(to) + '||fired';
      collapsed.set(ck, {
        source: nodeIndex.get(from),
        target: nodeIndex.get(to),
        value: v,
        kind: 'fired',
      });
    }

    const finalLinks = Array.from(collapsed.values()).filter(l => l.value > 0);

    // ── 5. Stats ──────────────────────────────────────────────────────────
    const totalTransitions = events.length;
    const stats = {
      total_leads: leads.length,
      leads_with_flow: leadsWithFlow,
      total_transitions: totalTransitions,
      total_automation_fires: runs.length,
      range_days: days,
      range_start: rangeStart.toISOString(),
      range_end: new Date().toISOString(),
      has_enough_data: totalTransitions >= 30,
    };

    return res.status(200).json({ nodes, links: finalLinks, stats });
  } catch (err) {
    console.error('[get-automations-flow] err:', err);
    try { await logError('get-automations-flow', err.message || String(err), {}); } catch (_e) {}
    return res.status(500).json({ error: 'Failed to load flow data', detail: err.message });
  }
}
