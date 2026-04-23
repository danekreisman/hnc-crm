/**
 * POST /api/run-task-automations  (Vercel cron: daily 8am HST = 6pm UTC)
 *
 * Task automations:
 *
 * 1. Quote sent → call lead next day
 *    - Finds leads where quote_sent_at was 1 day ago
 *    - No existing call_lead task for that lead
 *    - Creates: "Call [Name] — quote follow-up" (high priority, due today)
 *
 * More automations can be added here as needed.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

async function generateCallBrief(db, lead) {
  try {
    const history = lead.phone ? await getOpenPhoneHistory(lead.phone, {
      apiKey: process.env.QUO_API_KEY,
      maxSms: 100,
      maxCalls: 10,
    }) : '';

    const prompt = [
      'You are a briefing assistant for Hawaii Natural Clean, a cleaning business in Hawaii.',
      'Generate a concise pre-call briefing for this lead. Factual only, no speculation.',
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const results = { quote_followups_created: 0, skipped: 0, errors: 0 };

  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // ── 1. Quote sent → call lead next day ──────────────────────────────────
    const { data: leads, error } = await db
      .from('leads')
      .select('id, name, phone, service, quote_total, address, notes')
      .gte('quote_sent_at', yesterday + 'T00:00:00Z')
      .lt('quote_sent_at', today + 'T00:00:00Z')
      .neq('stage', 'Closed won');  // don't follow up on booked leads

    if (error) throw error;

    for (const lead of leads || []) {
      try {
        // Skip if a call_lead task already exists for this lead
        const exists = await taskExists(db, 'call_lead', lead.id);
        if (exists) { results.skipped++; continue; }

        // Generate AI brief
        const brief = await generateCallBrief(db, lead);

        // Create the task
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
        console.log(`[run-task-automations] Created quote follow-up task for ${lead.name}`);

      } catch (leadErr) {
        await logError('run-task-automations:lead', leadErr, { leadId: lead.id });
        results.errors++;
      }
    }

    return res.status(200).json({ success: true, ...results });

  } catch (err) {
    await logError('run-task-automations', err, {});
    return res.status(500).json({ error: err.message });
  }
}
