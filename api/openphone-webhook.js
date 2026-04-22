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