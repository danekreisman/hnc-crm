import { isWebhookProcessed, recordWebhook } from './utils/webhook-idempotency.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'OpenPhone webhook receiver active' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  async function supabaseInsert(table, data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(data)
    });
    return res;
  }

  async function supabaseUpsert(table, data, onConflict) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(data)
    });
    return res;
  }

  async function findClientByPhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '').slice(-10);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=id,name,phone&limit=100`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const clients = await res.json();
    if (!Array.isArray(clients)) return null;
    return clients.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === digits) || null;
  }

  async function findLeadByPhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '').slice(-10);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?select=id,phone&limit=100`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const leads = await res.json();
    if (!Array.isArray(leads)) return null;
    return leads.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === digits) || null;
  }

  /**
   * Classify a lead's inbound SMS using Claude Haiku to detect lost-intent.
   * Cheap (~$0.001/call) and fast. Returns { intent, confidence, reasoning }
   * where intent is 'lost' | 'engaged' | 'deferred' | 'unclear' and
   * confidence is 'high' | 'medium' | 'low'. We only act on 'lost' with
   * non-low confidence — everything else just goes to the inbox. False
   * positives are worse than false negatives (we'd hide a real customer),
   * so the prompt is intentionally conservative.
   */
  async function classifyLeadResponse(messageBody, leadName) {
    const prompt = [
      'You are classifying a single inbound SMS reply from a sales lead.',
      'The lead may be telling us they chose another company, lost interest, no longer need the service, or are deferring.',
      '',
      `Lead name: ${leadName || 'Unknown'}`,
      `Their reply: "${messageBody}"`,
      '',
      'Classify the intent into ONE of these categories:',
      '  - "lost": clearly indicates they will not use our service. Examples: "we went with someone else", "we ended up choosing another company", "no longer need it", "we hired a different cleaner", "we are not interested", "please remove me from your list".',
      '  - "engaged": positive interest, asking questions, wanting to schedule. Examples: "yes lets do it", "what time works", "can we book Tuesday", "i have a question about pricing".',
      '  - "deferred": want service eventually but not now. Examples: "we are going to wait", "maybe next month", "still thinking about it", "after the move", "let me get back to you".',
      '  - "unclear": ambiguous, off-topic, or neutral. Default to this if uncertain.',
      '',
      'Confidence levels:',
      '  - "high": clear, unambiguous lost signal',
      '  - "medium": likely lost but some interpretation involved',
      '  - "low": might be lost, might be deferred — coin flip',
      '',
      'Be CONSERVATIVE. False positives are worse than false negatives — we only auto-create a task for "lost" intent at medium or high confidence. When in doubt, classify as "unclear" or "deferred".',
      '',
      'Return ONLY a JSON object — first character must be { and last must be }. No preamble, no postamble, no markdown.',
      'Format: {"intent": "lost"|"engaged"|"deferred"|"unclear", "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}',
    ].join('\n');

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!aiResp.ok) throw new Error('Anthropic API HTTP ' + aiResp.status);
    const data = await aiResp.json();
    const text = data?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned empty response');

    // Brace-tracking JSON extractor — same pattern used in lead-followup-generate.
    // Avoids indexOf/lastIndexOf brittleness when the model adds preamble or postamble.
    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON in AI response');
    let depth = 0, inString = false, escape = false, jsonStr = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) { if (ch === '\\') { escape = true; continue; } if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonStr = text.slice(start, i + 1); break; } }
    }
    if (!jsonStr) throw new Error('Unbalanced JSON in AI response');
    return JSON.parse(jsonStr);
  }

  try {
    const event = req.body;
    const type = event.type;
    const data = event.data?.object;
    const eventId = event.id; // OpenPhone event ID for idempotency

    console.log('OpenPhone webhook received:', type, 'Event ID:', eventId);

    // IDEMPOTENCY CHECK: Skip if this webhook was already processed
    if (eventId) {
      try {
        const alreadyProcessed = await isWebhookProcessed(eventId, 'openphone', SUPABASE_KEY);
        if (alreadyProcessed) {
          console.log('[openphone-webhook] Webhook already processed:', eventId);
          return res.status(200).json({ received: true, type, alreadyProcessed: true });
        }
      } catch (idempotencyErr) {
        console.error('[openphone-webhook] Idempotency check failed:', idempotencyErr.message);
        // If idempotency check fails, fail the webhook to be safe
        return res.status(500).json({ error: 'Idempotency check failed' });
      }
    }

    if (type === 'message.received' && data) {
      const from = data.from;
      const body = data.body || '';
      const client = await findClientByPhone(from);
      const lead = await findLeadByPhone(from);

      await supabaseInsert('messages', {
        thread_id: data.conversationId || from,
        contact_name: client ? client.name : from,
        contact_phone: from,
        contact_type: client ? 'client' : 'unknown',
        direction: 'inbound',
        body: body,
        channel: 'sms',
        read: false,
        quo_message_id: data.id || null
      });

      // If this is a lead response, track it
      if (lead) {
        const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${lead.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            response_count: (lead.response_count || 0) + 1,
            last_responded_at: new Date().toISOString()
          })
        });
        console.log('Lead response tracked:', lead.id, updateRes.status);

        // ── AI classification: does this reply suggest the lead is lost? ──
        // If Haiku returns 'lost' with reasonable confidence, create a VA
        // task for Dane to review. We do NOT auto-flip the stage — the
        // boundary between 'lost' and 'cold/deferred' is fuzzy and
        // false positives would silently lose customers.
        if (body && body.trim() && process.env.ANTHROPIC_API_KEY) {
          try {
            const verdict = await classifyLeadResponse(body, lead.name);
            console.log('[openphone-webhook] AI verdict for lead', lead.id, ':', JSON.stringify(verdict));
            if (verdict && verdict.intent === 'lost' && verdict.confidence !== 'low') {
              // Create a VA task — surfaces in the Tasks view with Yes/No buttons
              const leadFirstName = (lead.name || 'Lead').split(' ')[0];
              const today = new Date().toISOString().split('T')[0];
              const truncatedReply = body.length > 200 ? body.slice(0, 197) + '...' : body;
              await supabaseInsert('tasks', {
                title: `${leadFirstName} responded — mark as lost?`,
                type: 'review_lead_response',
                priority: verdict.confidence === 'high' ? 'high' : 'medium',
                due_date: today,
                description: `Reply: "${truncatedReply}"\n\nAI read: ${verdict.reasoning || 'lead appears lost'} (confidence: ${verdict.confidence})`,
                related_lead_id: lead.id,
                status: 'open',
              });
              console.log('[openphone-webhook] Created review_lead_response task for', lead.id);
            }
          } catch (aiErr) {
            // Never fail the webhook on AI errors — classification is bonus
            console.warn('[openphone-webhook] AI classification failed:', aiErr.message);
          }
        }
      }
    }

    if (type === 'call.completed' && data) {
      const direction = data.direction;
      const phone = direction === 'inbound' ? data.from : data.to;
      const client = await findClientByPhone(phone);

      await supabaseUpsert('call_transcripts', {
        call_id: data.id,
        phone: phone,
        direction: direction,
        duration_seconds: data.duration,
        called_at: data.createdAt || new Date().toISOString(),
        status: 'completed',
        client_id: client ? client.id : null,
        client_name: client ? client.name : ('Unknown — ' + phone)
      }, 'call_id');
    }

    if (type === 'call.summary.completed' && data) {
      const summary = Array.isArray(data.summary)
        ? data.summary.join(' ')
        : (data.summary || '');

      await supabaseUpsert('call_transcripts', {
        call_id: data.callId,
        summary: summary,
        status: 'summary_ready'
      }, 'call_id');
    }

    if (type === 'call.transcript.completed' && data) {
      const dialogue = data.dialogue || [];
      const transcript = dialogue.map(l => (l.identifier || 'Unknown') + ': ' + l.content).join('\n');

      await supabaseUpsert('call_transcripts', {
        call_id: data.callId,
        transcript: transcript,
        status: 'transcript_ready'
      }, 'call_id');
    }

    // Record the webhook as processed
    if (eventId) {
      try {
        await recordWebhook(eventId, 'openphone', type, event, SUPABASE_KEY);
      } catch (recordErr) {
        console.warn('[openphone-webhook] Failed to record webhook:', recordErr.message);
        // Don't fail the whole webhook if recording fails, but log it
      }
    }

    return res.status(200).json({ received: true, type });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}