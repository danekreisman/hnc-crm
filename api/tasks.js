/**
 * /api/tasks
 *
 * GET  ?status=open|completed   â list tasks
 * POST { action: 'create', ... } â create task (+ optionally generate AI brief)
 * POST { action: 'complete', id } â mark complete
 * POST { action: 'delete', id }   â delete task
 */

import { requireAuth } from './utils/auth-check.js';
import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

async function generateAiBrief(db, task) {
  try {
    let subject = null;
    let phone = null;

    if (task.related_lead_id) {
      const { data: lead } = await db.from('leads')
        .select('name, email, phone, service, quote_total, stage, segment, notes, address')
        .eq('id', task.related_lead_id).maybeSingle();
      subject = lead;
      phone = lead?.phone;
    } else if (task.related_client_id) {
      const { data: client } = await db.from('clients')
        .select('name, email, phone, service, frequency, status, notes')
        .eq('id', task.related_client_id).maybeSingle();
      subject = client;
      phone = client?.phone;
    }

    if (!subject) return null;

    // Pull OpenPhone history
    const history = phone ? await getOpenPhoneHistory(phone, {
      apiKey: process.env.QUO_API_KEY,
      maxSms: 100,
      maxCalls: 10,
    }) : '';

    const prompt = [
      `You are a briefing assistant for Hawaii Natural Clean, a cleaning business in Hawaii.`,
      `Generate a concise pre-call briefing for the following ${task.related_lead_id ? 'lead' : 'client'}.`,
      `Rules: factual only, no speculation. Include: who they are, what they need, relevant history, any open issues or preferences. End with 1-2 specific talking points for the call.`,
      ``,
      `Name: ${subject.name}`,
      subject.service ? `Service interest: ${subject.service}` : '',
      subject.quote_total ? `Quote: $${subject.quote_total}` : '',
      subject.stage ? `Lead stage: ${subject.stage}` : '',
      subject.frequency ? `Frequency: ${subject.frequency}` : '',
      subject.address ? `Address: ${subject.address}` : '',
      subject.notes ? `Notes: ${subject.notes}` : '',
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
    await logError('tasks:ai-brief', err, { taskId: task.id });
    return null;
  }
}

export default async function handler(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // ââ GET: list tasks âââââââââââââââââââââââââââââââââââââââââââââââââââ
    if (req.method === 'GET') {
      const status = req.query.status || 'open';
      let query = db.from('tasks')
        .select('*, leads(name, phone), clients(name, phone)')
        .eq('status', status)
        .order(status === 'open' ? 'due_date' : 'completed_at', { ascending: status === 'open' });

      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json({ tasks: data });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action, id, ...body } = req.body || {};

    // ââ complete ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if (action === 'complete') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await db.from('tasks').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ââ delete ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await db.from('tasks').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ââ create ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if (action === 'create') {
      const { title, description, type, priority, due_date,
              related_lead_id, related_client_id } = body;

      if (!title?.trim()) return res.status(400).json({ error: 'title is required' });

      const { data: task, error } = await db.from('tasks').insert([{
        title: title.trim(),
        description: description?.trim() || null,
        type: type || 'other',
        priority: priority || 'medium',
        due_date: due_date || null,
        related_lead_id: related_lead_id || null,
        related_client_id: related_client_id || null,
        status: 'open',
      }]).select().single();

      if (error) throw error;

      // Generate AI brief for call tasks in the background
      if ((type === 'call_lead' || type === 'call_client') &&
          (related_lead_id || related_client_id)) {
        const brief = await generateAiBrief(db, task);
        if (brief) {
          await db.from('tasks').update({ ai_brief: brief }).eq('id', task.id);
          task.ai_brief = brief;
        }
      }

      
    // Notify VA via SMS
    try {
      await fetchWithTimeout('/api/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+18084685356',
          message: 'New task assigned: ' + (body.title || body.task_title || 'Untitled') + (body.due_date ? ' (Due: ' + body.due_date + ')' : '') + '. Check the CRM for details.'
        })
      }, 10000);
    } catch(smsErr) {
      await logError('tasks-sms', smsErr.message, { task: body });
    }
    return res.status(200).json({ success: true, task });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    await logError('tasks', err, { action: req.body?.action });
    return res.status(500).json({ error: err.message });
  }
}
