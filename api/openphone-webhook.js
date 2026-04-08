import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://hehfecnjmgsthxjxlvpz.supabase.co',
  process.env.SUPABASE_ANON_KEY
);

async function findClientByPhone(phone) {
  if (!phone) return null;
  // Normalize phone - strip all non-digits
  const digits = phone.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  
  const { data } = await supabase
    .from('clients')
    .select('id, name, phone')
    .limit(50);
  
  if (!data) return null;
  
  // Match by last 10 digits
  const match = data.find(c => {
    if (!c.phone) return false;
    const cDigits = c.phone.replace(/\D/g, '').slice(-10);
    return cDigits === last10;
  });
  
  return match || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'OpenPhone webhook receiver active' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const event = req.body;
    const type = event.type;
    const data = event.data?.object;

    console.log('OpenPhone webhook:', type);

    // INCOMING MESSAGE
    if (type === 'message.received' && data) {
      const from = data.from;
      const body = data.body || '';
      const client = await findClientByPhone(from);

      await supabase.from('messages').insert([{
        thread_id: data.conversationId || from,
        contact_name: client ? client.name : from,
        contact_phone: from,
        contact_type: client ? 'client' : 'unknown',
        direction: 'inbound',
        body: body,
        channel: 'sms',
        read: false,
        quo_message_id: data.id || null
      }]);

      console.log('Message saved from:', client ? client.name : 'unknown ' + from);
    }

    // CALL COMPLETED
    if (type === 'call.completed' && data) {
      const direction = data.direction;
      const phone = direction === 'inbound' ? data.from : data.to;
      const client = await findClientByPhone(phone);

      await supabase.from('call_transcripts').upsert([{
        call_id: data.id,
        phone: phone,
        direction: direction,
        duration_seconds: data.duration,
        called_at: data.createdAt || new Date().toISOString(),
        status: 'completed',
        client_id: client ? client.id : null,
        client_name: client ? client.name : 'Unknown — ' + phone
      }], { onConflict: 'call_id' });

      console.log('Call saved:', data.id, client ? client.name : 'unknown ' + phone);
    }

    // CALL SUMMARY
    if (type === 'call.summary.completed' && data) {
      const summary = Array.isArray(data.summary)
        ? data.summary.join(' ')
        : (data.summary || '');

      await supabase.from('call_transcripts').upsert([{
        call_id: data.callId,
        summary: summary,
        status: 'summary_ready'
      }], { onConflict: 'call_id' });

      console.log('Summary saved:', data.callId);
    }

    // CALL TRANSCRIPT
    if (type === 'call.transcript.completed' && data) {
      const dialogue = data.dialogue || [];
      const transcript = dialogue.map(function(line) {
        return (line.identifier || 'Unknown') + ': ' + line.content;
      }).join('\n');

      await supabase.from('call_transcripts').upsert([{
        call_id: data.callId,
        transcript: transcript,
        status: 'transcript_ready'
      }], { onConflict: 'call_id' });

      console.log('Transcript saved:', data.callId);
    }

    return res.status(200).json({ received: true, type });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}
