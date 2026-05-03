/**
 * /api/tasks
 *
 * GET  ?status=open|completed   — list tasks
 * POST { action: 'create', ... } — create task (+ optionally generate AI brief)
 * POST { action: 'complete', id } — mark complete
 * POST { action: 'delete', id }   — delete task
 */

import { createClient } from '@supabase/supabase-js';
import { isAutomationEnabled } from './utils/automation-gate.js';
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Auth check
  const _authHdr = req.headers.authorization || "";
  const _token = _authHdr.replace("Bearer ", "").trim();
  if (!_token) return res.status(401).json({ error: "Unauthorized" });
  const _authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + "/auth/v1/user",
    { headers: { "Authorization": "Bearer " + _token, "apikey": process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!_authCheck.ok) return res.status(401).json({ error: "Unauthorized" });

  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // ── GET: list tasks ───────────────────────────────────────────────────
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

    // ── complete ──────────────────────────────────────────────────────────
    if (action === 'complete') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await db.from('tasks').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'reopen') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await db.from('tasks').update({
        status: 'open',
        completed_at: null,
      }).eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ── delete ────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await db.from('tasks').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ── create ────────────────────────────────────────────────────────────
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

      // Email VA — gated by task_created_email_enabled
      if (await isAutomationEnabled(db, 'task_created_email_enabled')) {
      try {
        const _title = body.title || body.task_title || "Untitled";
        const _due = body.due_date ? new Date(body.due_date).toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}) : null;
        await fetchWithTimeout("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.RESEND_API_KEY },
          body: JSON.stringify({
            from: "HNC CRM <noreply@hawaiinaturalclean.com>",
            to: "dane@hawaiinaturalclean.net",
            subject: "New Task: " + _title,
            html: "<div style=\"font-family:Inter,sans-serif;padding:2rem;max-width:500px\"><h2>New Task Assigned</h2><p><strong>Task:</strong> " + _title + "</p>" + (_due ? "<p><strong>Due:</strong> " + _due + "</p>" : "") + (body.notes ? "<p><strong>Notes:</strong> " + body.notes + "</p>" : "") + "<a href=\"https://hnc-crm.vercel.app\" style=\"background:#3BB8E3;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;display:inline-block;margin-top:1rem\">View in CRM</a></div>"
          })
        }, 10000);
        // Log VA-task email to activity_logs (direct Resend bypasses /api/send-email)
        try {
          await fetch(process.env.SUPABASE_URL + '/rest/v1/activity_logs', {
            method: 'POST',
            headers: {
              'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({
              action: 'email_sent_va_task',
              description: 'VA task email: ' + (body.title || body.task_title || 'Untitled'),
              user_email: 'system',
              entity_type: 'task',
              entity_id: '',
              metadata: { task_title: body.title || body.task_title, due_date: body.due_date || null },
            }),
          });
        } catch (_) { /* logging failure must not break the send */ }
      } catch(_emailErr) {
        await logError("tasks-email", _emailErr.message, { task: body });
      }
      } else { console.log('[tasks] task_created_email disabled — skipping'); }
      // SMS notification to VA — gated by task_created_sms_enabled
      if (await isAutomationEnabled(db, 'task_created_sms_enabled')) {
      try {
        const _title = body.title || body.task_title || "Untitled";
        const _due = body.due_date ? " (Due: " + new Date(body.due_date).toLocaleDateString("en-US",{month:"short",day:"numeric"}) + ")" : "";
        await fetchWithTimeout("/api/send-sms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: "+18084685356", message: "New task: " + _title + _due + ". Check CRM." })
        }, 10000);
      } catch(_smsErr) {
        await logError("tasks-sms", _smsErr.message, { task: body });
      }
      // Push fan-out — same flag gate as the SMS. Fire-and-forget so the
      // POST /api/tasks response isn't blocked on push delivery.
      import('./utils/send-push.js').then(({ sendPushToAllSubscribed }) => {
        const _title = body.title || body.task_title || 'Untitled';
        const _due = body.due_date ? ' (due ' + new Date(body.due_date).toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ')' : '';
        return sendPushToAllSubscribed({
          title: '\u{1F4DD} New task: ' + _title,
          body: 'Tap to view in the CRM' + _due,
          url: '/#tasks',
          tag: 'new-task-' + (task && task.id ? task.id : Date.now()),
        });
      }).then(r => r && console.log('[tasks] owner push:', JSON.stringify(r)))
        .catch(err => console.warn('[tasks] owner push failed:', err.message));
      } else { console.log('[tasks] task_created_sms disabled — skipping'); }
      return res.status(200).json({ success: true, task });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    await logError('tasks', err, { action: req.body?.action });
    return res.status(500).json({ error: err.message });
  }
}
