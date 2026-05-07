/**
 * POST /api/run-task-automations  (Vercel cron: daily 8am HST = 6pm UTC)
 *
 * VA task automations (creates internal todo items — does NOT contact anyone):
 *
 * 1. Quote Day 1 followup
 *    - Trigger: lead's quote_sent_at was yesterday (≈18-42h ago at cron time)
 *    - Filter: stage not in (Closed won, Closed lost) — i.e. fires even if responsive
 *    - Idempotency: skip if an open call_lead task already exists for the lead
 *    - Output: high-priority "Call [Name] — quote follow-up" task with AI brief
 *
 * 2. Day 5 re-engagement call (NEW)
 *    - Trigger: lead's quote_sent_at was 5 days ago (≈4.5-5.5d window)
 *    - Filter: stage not in (Closed won, Closed lost)
 *    - Idempotency: skip if an open call_lead_reengagement task already exists
 *    - Output: high-priority "Call [Name] — 5-day re-engagement" task with AI brief
 *
 * 3. Post-first-appointment call lives in run-job-completions.js (hourly cron).
 *
 * 4. Pipeline stage advance: Quoted → Long-Term Follow-Up after 3 days of no reply.
 *    - Pure DB write, no kill switch (low blast radius).
 *    - Leads with last_responded_at set are skipped (they're being handled).
 *
 * TEST MODE GUARD: while TASK_AUTOMATIONS_TEST_MODE = true, ONLY records matching
 * Dane Kreisman's phone or email get tasks created. The stage-advance step does
 * NOT respect TEST_MODE — it's a DB-only operation with no contact side effects.
 * Flip to false to roll out fully.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';
import { isAutomationEnabled } from './utils/automation-gate.js';
import { generateCallBrief } from './utils/generate-brief.js';

// ── TEST MODE: limit task creation to Dane only during rollout ─────────────
const TASK_AUTOMATIONS_TEST_MODE = false;
const DANE_PHONE_DIGITS = '8082697636';
const DANE_EMAIL = 'dane.kreisman@gmail.com';

function _digitsOnly(s){ return (s||'').replace(/\D/g,''); }

function isTestSafeRecord(record){
  if(!TASK_AUTOMATIONS_TEST_MODE) return true;
  if(!record) return false;
  var phoneD = _digitsOnly(record.phone);
  if(phoneD && phoneD.indexOf(DANE_PHONE_DIGITS) >= 0) return true;
  var email = (record.email||'').trim().toLowerCase();
  if(email && email === DANE_EMAIL) return true;
  return false;
}

async function taskExists(db, type, relatedLeadId) {
  const { data } = await db.from('tasks')
    .select('id')
    .eq('type', type)
    .eq('related_lead_id', relatedLeadId)
    .eq('status', 'open')
    .limit(1);
  return data && data.length > 0;
}

// Phase 2 coordination layer (2026-05-05). Returns true if there's an
// ENABLED `stage_entered` automation in lead_automations that covers the
// given stage + action type with delay_minutes inside [minDelay, maxDelay].
// The window is intentional: a user-configured Day-1 automation should NOT
// suppress the legacy Day-5 job (different business intent), and vice versa.
//
// Used by the legacy hardcoded jobs below to skip leads that the new
// framework will handle, preventing duplicate VA tasks. Fail-OPEN: if the
// query errors, returns false so the legacy job still runs (better to have
// a duplicate task than a missed one — Dane can dismiss dupes; missed
// tasks are silent).
async function isStageEnteredCovered(db, stage, actionType, minDelayMinutes, maxDelayMinutes) {
  try {
    const { data, error } = await db
      .from('lead_automations')
      .select('id, name, trigger_config, actions')
      .eq('trigger_type', 'stage_entered')
      .eq('is_enabled', true);
    if (error || !data) return false;
    for (const row of data) {
      const cfg = row.trigger_config || {};
      if (cfg.stage !== stage) continue;
      const delay = typeof cfg.delay_minutes === 'number' ? cfg.delay_minutes : 0;
      if (delay < minDelayMinutes || delay > maxDelayMinutes) continue;
      const actions = row.actions || [];
      const hasActionType = actions.some(a => a && a.type === actionType);
      if (hasActionType) {
        console.log(`[run-task-automations] legacy ${stage}/${actionType} (delay window ${minDelayMinutes}-${maxDelayMinutes}m) superseded by automation '${row.name}' (id=${row.id}, delay=${delay}m)`);
        return true;
      }
    }
    return false;
  } catch (e) {
    console.warn('[isStageEnteredCovered] err:', e.message);
    return false; // fail-open
  }
}

async function logActivity(action, description, metadata={}) {
  try {
    await fetch(process.env.SUPABASE_URL+'/rest/v1/activity_logs', {
      method:'POST',
      headers:{'apikey':process.env.SUPABASE_SERVICE_ROLE_KEY,'Authorization':'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({action,description,user_email:'system',entity_type:action,metadata})
    });
  } catch(_){}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const results = {
    quote_followups_created: 0,
    reengagement_calls_created: 0,
    skipped_idempotent: 0,
    skipped_test_mode: 0,
    errors: 0,
    test_mode: TASK_AUTOMATIONS_TEST_MODE
  };

  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // ── 1. Quote Day 1 followup (quote sent yesterday → call today) ──────────
    const day1Enabled = await isAutomationEnabled(db, 'va_task_quote_day1_enabled');
    if (!day1Enabled) {
      console.log('[run-task-automations] Day 1 disabled — skipping');
    } else {
    const { data: day1Leads, error: day1Err } = await db
      .from('leads')
      .select('id, name, phone, email, service, quote_total, address, notes, stage')
      .gte('quote_sent_at', yesterday + 'T00:00:00Z')
      .lt('quote_sent_at', today + 'T00:00:00Z')
      .not('stage', 'in', '("Closed won","Closed lost")');

    if (day1Err) throw day1Err;

    // Phase 2 coordination: if there's an enabled stage_entered automation
    // for Quoted with delay 0-3000 min (~0-50h, covering Day-0 and Day-1
    // intents) that creates a VA task, that automation is the new source of
    // truth — skip the legacy path entirely for this run. Window is bounded
    // to avoid suppressing the Day-5 job when only a Day-1 automation exists.
    const day1SupersededByFramework = await isStageEnteredCovered(db, 'Quoted', 'create_va_task', 0, 3000);

    for (const lead of day1Leads || []) {
      try {
        if (day1SupersededByFramework) { results.skipped_idempotent++; continue; }
        if (!isTestSafeRecord(lead)) { results.skipped_test_mode++; continue; }
        const exists = await taskExists(db, 'call_lead', lead.id);
        if (exists) { results.skipped_idempotent++; continue; }

        const brief = await generateCallBrief(lead, 'day1');
        const { error: taskErr } = await db.from('tasks').insert([{
          title: `Call ${lead.name} — quote follow-up`,
          type: 'call_lead',
          priority: 'high',
          due_date: today,
          description: lead.quote_total
            ? `Quote of $${lead.quote_total} was sent yesterday. Follow up to answer questions and book.`
            : 'Quote was sent yesterday. Follow up to answer questions and book.',
          related_lead_id: lead.id,
          status: 'open',
          ai_brief: brief,
        }]);

        if (taskErr) throw taskErr;
        results.quote_followups_created++;
        await logActivity('va_task_created', `Day 1 quote follow-up for ${lead.name}`, { task_type:'call_lead', lead_id:lead.id, automation:'quote_day1' });
        console.log(`[run-task-automations] Day 1 quote follow-up for ${lead.name}`);

      } catch (leadErr) {
        await logError('run-task-automations:day1', leadErr, { leadId: lead.id });
        results.errors++;
      }
    }
    } // end of day1Enabled block

    // ── 2. Day 5 re-engagement call (quote sent 5d ago → call today) ────────
    const day5Enabled = await isAutomationEnabled(db, 'va_task_quote_day5_enabled');
    if (!day5Enabled) {
      console.log('[run-task-automations] Day 5 disabled — skipping');
    } else {
    const { data: day5Leads, error: day5Err } = await db
      .from('leads')
      .select('id, name, phone, email, service, quote_total, address, notes, stage')
      .gte('quote_sent_at', fiveDaysAgo + 'T00:00:00Z')
      .lt('quote_sent_at', fourDaysAgo + 'T00:00:00Z')
      .not('stage', 'in', '("Closed won","Closed lost")');

    if (day5Err) throw day5Err;

    // Phase 2 coordination: same pattern as Day-1, but window targets
    // Day-3-to-Day-7 intents (4320-10080 min) so a Day-1 automation does
    // NOT suppress this Day-5 legacy job.
    const day5SupersededByFramework = await isStageEnteredCovered(db, 'Quoted', 'create_va_task', 4320, 10080);

    for (const lead of day5Leads || []) {
      try {
        if (day5SupersededByFramework) { results.skipped_idempotent++; continue; }
        if (!isTestSafeRecord(lead)) { results.skipped_test_mode++; continue; }
        const exists = await taskExists(db, 'call_lead_reengagement', lead.id);
        if (exists) { results.skipped_idempotent++; continue; }

        const brief = await generateCallBrief(lead, 'reengagement');
        const { error: taskErr } = await db.from('tasks').insert([{
          title: `Call ${lead.name} — 5-day re-engagement`,
          type: 'call_lead_reengagement',
          priority: 'high',
          due_date: today,
          description: lead.quote_total
            ? `Quote of $${lead.quote_total} sent 5 days ago and still no booking. Surface objections and offer to schedule.`
            : 'Quote sent 5 days ago and still no booking. Surface objections and offer to schedule.',
          related_lead_id: lead.id,
          status: 'open',
          ai_brief: brief,
        }]);

        if (taskErr) throw taskErr;
        results.reengagement_calls_created++;
        await logActivity('va_task_created', `Day 5 re-engagement call for ${lead.name}`, { task_type:'call_lead_reengagement', lead_id:lead.id, automation:'quote_day5' });
        console.log(`[run-task-automations] Day 5 re-engagement for ${lead.name}`);

      } catch (leadErr) {
        await logError('run-task-automations:day5', leadErr, { leadId: lead.id });
        results.errors++;
      }
    }
    } // end of day5Enabled block

    // ── 3. Pipeline stage advance: Quoted → Long-Term Follow-Up (variant-aware) ──
    // Pure DB write, no SMS/email side effects. Always runs (no kill switch).
    //
    // Tide Phase 3 (2026-05-07): the timeout is now service-type aware so
    // leads get their full cadence before being moved out of Quoted:
    //   - Move-out Cleaning: 7 days  (matches Move-Out variant cadence)
    //   - Deep Cleaning:     10 days (matches Deep Clean variant cadence)
    //   - Regular Cleaning:  14 days (matches Regular variant cadence)
    //   - other / null:      14 days (use longest cadence as a safety default)
    //
    // Criteria: stage='Quoted' AND quote_sent_at is older than the variant's
    // timeout AND no inbound reply tracked AND not blacklisted. Leads who
    // replied stay in Quoted (the human-review tasks from Tide cadences
    // handle the next step for them).
    //
    // Implementation: query each service bucket separately so the timeout
    // can vary. Slightly more queries but each is indexed (leads.stage,
    // leads.service) and the result sets are tiny.
    try {
      const dayMs = 24 * 60 * 60 * 1000;
      const variantTimeouts = [
        { service: 'Move-out Cleaning', days: 7 },
        { service: 'Deep Cleaning',     days: 10 },
        { service: 'Regular Cleaning',  days: 14 },
      ];
      const knownServices = variantTimeouts.map(v => v.service);
      let totalAdvanced = 0;

      // Per-variant queries
      for (const v of variantTimeouts) {
        const cutoff = new Date(Date.now() - v.days * dayMs).toISOString();
        const { data: stale, error: staleErr } = await db
          .from('leads')
          .select('id')
          .eq('stage', 'Quoted')
          .eq('service', v.service)
          .lt('quote_sent_at', cutoff)
          .is('last_responded_at', null)
          .eq('do_not_contact', false);
        if (staleErr) {
          console.warn(`[run-task-automations] stage-advance query error (${v.service}):`, staleErr.message);
          continue;
        }
        if (stale && stale.length) {
          const ids = stale.map(r => r.id);
          const { error: updateErr } = await db
            .from('leads')
            .update({ stage: 'Long-Term Follow-Up' })
            .in('id', ids);
          if (updateErr) {
            console.warn(`[run-task-automations] stage-advance update error (${v.service}):`, updateErr.message);
          } else {
            console.log(`[run-task-automations] Advanced ${ids.length} ${v.service} leads from Quoted → Long-Term Follow-Up (${v.days}d timeout)`);
            totalAdvanced += ids.length;
          }
        }
      }

      // Catch-all for services without a Tide variant (Janitorial, Airbnb,
      // null, anything custom). Uses 14-day timeout as a safety default —
      // longer than any explicit variant so we never advance a Tide-eligible
      // lead before its variant's timeout fires.
      const defaultCutoff = new Date(Date.now() - 14 * dayMs).toISOString();
      let defaultQuery = db
        .from('leads')
        .select('id')
        .eq('stage', 'Quoted')
        .lt('quote_sent_at', defaultCutoff)
        .is('last_responded_at', null)
        .eq('do_not_contact', false);
      // Use Postgrest's not.in for the exclusion; values are quoted by the client
      defaultQuery = defaultQuery.not('service', 'in', `("${knownServices.join('","')}")`);
      const { data: staleDefault, error: defaultErr } = await defaultQuery;
      if (defaultErr) {
        console.warn('[run-task-automations] stage-advance default query error:', defaultErr.message);
      } else if (staleDefault && staleDefault.length) {
        const ids = staleDefault.map(r => r.id);
        const { error: updateErr } = await db
          .from('leads')
          .update({ stage: 'Long-Term Follow-Up' })
          .in('id', ids);
        if (updateErr) {
          console.warn('[run-task-automations] stage-advance default update error:', updateErr.message);
        } else {
          console.log(`[run-task-automations] Advanced ${ids.length} non-variant leads from Quoted → Long-Term Follow-Up (14d default)`);
          totalAdvanced += ids.length;
        }
      }

      results.stage_advanced_to_followup = totalAdvanced;
    } catch (saErr) {
      console.warn('[run-task-automations] stage-advance unexpected error:', saErr.message);
      results.stage_advanced_to_followup = 0;
    }

    return res.status(200).json({ success: true, ...results });

  } catch (err) {
    await logError('run-task-automations', err, {});
    return res.status(500).json({ error: err.message });
  }
}
