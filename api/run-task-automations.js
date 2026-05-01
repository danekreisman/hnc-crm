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
 * 4. Pipeline stage advance: Quoted → Follow-up after 3 days of no reply.
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
import { getOpenPhoneHistory } from './utils/openphone-history.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { isAutomationEnabled } from './utils/automation-gate.js';
import { buildSummaryPrompt } from './utils/summary-prompt.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// ── TEST MODE: limit task creation to Dane only during rollout ─────────────
const TASK_AUTOMATIONS_TEST_MODE = true;
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

async function generateCallBrief(db, lead, purpose) {
  try {
    const history = lead.phone ? await getOpenPhoneHistory(lead.phone, {
      apiKey: process.env.QUO_API_KEY,
      maxSms: 100,
      maxCalls: 10,
    }) : '';

    // Surface the call purpose at the top of the rep's brief by prepending
    // it to the Notes field — the structured prompt template takes care of
    // the rest of the format.
    const purposeNote = purpose === 'reengagement'
      ? 'CALL PURPOSE: Day-5 re-engagement call. Lead got a quote 5 days ago and has not booked. Surface specific objections and any unanswered questions from their conversation.'
      : 'CALL PURPOSE: Day-1 follow-up call. Quote went out yesterday — confirm receipt, answer questions, push toward booking.';

    const prompt = buildSummaryPrompt({
      mode: 'va_brief',
      data: {
        name: lead.name,
        service: lead.service,
        quote_total: lead.quote_total,
        address: lead.address,
        notes: lead.notes ? `${purposeNote}\n\n${lead.notes}` : purposeNote,
      },
      history,
    });

    const resp = await fetchWithTimeout(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, TIMEOUTS.ANTHROPIC);

    const data = await resp.json();
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error('[run-task-automations] AI brief failed:', err.message);
    return null;
  }
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

    for (const lead of day1Leads || []) {
      try {
        if (!isTestSafeRecord(lead)) { results.skipped_test_mode++; continue; }
        const exists = await taskExists(db, 'call_lead', lead.id);
        if (exists) { results.skipped_idempotent++; continue; }

        const brief = await generateCallBrief(db, lead, 'day1');
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

    for (const lead of day5Leads || []) {
      try {
        if (!isTestSafeRecord(lead)) { results.skipped_test_mode++; continue; }
        const exists = await taskExists(db, 'call_lead_reengagement', lead.id);
        if (exists) { results.skipped_idempotent++; continue; }

        const brief = await generateCallBrief(db, lead, 'reengagement');
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

    // ── 3. Pipeline stage advance: Quoted → Follow-up after 3 days of silence ──
    // Pure DB write, no SMS/email side effects. Always runs (no kill switch).
    // Criteria: stage='Quoted' AND quote_sent_at is 3+ days old AND no inbound
    // reply tracked AND not blacklisted. Leads who replied stay in Quoted (the
    // VA-task automations handle the human follow-up for them).
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const { data: stale, error: staleErr } = await db
        .from('leads')
        .select('id, name')
        .eq('stage', 'Quoted')
        .lt('quote_sent_at', threeDaysAgo)
        .is('last_responded_at', null)
        .eq('do_not_contact', false);

      if (staleErr) {
        console.warn('[run-task-automations] stage-advance query error:', staleErr.message);
      } else if (stale && stale.length) {
        const ids = stale.map(r => r.id);
        const { error: updateErr } = await db
          .from('leads')
          .update({ stage: 'Follow-up' })
          .in('id', ids);
        if (updateErr) {
          console.warn('[run-task-automations] stage-advance update error:', updateErr.message);
        } else {
          console.log(`[run-task-automations] Advanced ${ids.length} leads from Quoted → Follow-up`);
          results.stage_advanced_to_followup = ids.length;
        }
      } else {
        results.stage_advanced_to_followup = 0;
      }
    } catch (advanceErr) {
      await logError('run-task-automations:stage-advance', advanceErr, {});
      results.errors++;
    }

    return res.status(200).json({ success: true, ...results });

  } catch (err) {
    await logError('run-task-automations', err, {});
    return res.status(500).json({ error: err.message });
  }
}
