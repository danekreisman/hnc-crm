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
 * TEST MODE GUARD: while TASK_AUTOMATIONS_TEST_MODE = true, ONLY records matching
 * Dane Kreisman's phone or email get tasks created. Flip to false to roll out fully.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { isAutomationEnabled } from './utils/automation-gate.js';

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

    const purposeLine = purpose === 'reengagement'
      ? 'This lead got a quote 5 days ago and has not booked. Generate a brief for a re-engagement call. Suggest one open-ended question to surface objections.'
      : 'Generate a concise pre-call briefing for this lead. Factual only, no speculation.';

    const prompt = [
      'You are a briefing assistant for Hawaii Natural Clean, a cleaning business in Hawaii.',
      purposeLine,
      'Include: who they are, what they need, quote details, and 1-2 specific talking points.',
      '',
      `Name: ${lead.name}`,
      lead.service ? `Service: ${lead.service}` : '',
      lead.quote_total ? `Quote sent: $${lead.quote_total}` : '',
      lead.address ? `Address: ${lead.address}` : '',
      lead.notes ? `Notes: ${lead.notes}` : '',
      history ? `\nConversation history:\n${history}` : '',
    ].filter(Boolean).join('\n');

    const resp = await fetchWithTimeout(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
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

    return res.status(200).json({ success: true, ...results });

  } catch (err) {
    await logError('run-task-automations', err, {});
    return res.status(500).json({ error: err.message });
  }
}
