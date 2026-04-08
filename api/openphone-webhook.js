import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://hehfecnjmgsthxjxlvpz.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

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

    console.log('OpenPhone webhook received:', type, JSON.stringify(event).slice(0, 200));

    // INCOMING MESSAGE — save to messages table
    if (type === 'message.received' && data) {
      const from = data.from;
      const body = data.body || '';
      const phoneNumberId = data.phoneNumberId;
      const conversationId = data.conversationId;

      await supabase.from('messages').insert([{
        thread_id: conversationId || from,
        contact_name: from,
        contact_phone: from,
        contact_type: 'client',
        direction: 'inbound',
        body: body,
        channel: 'sms',
        read: false,
        quo_message_id: data.id || null
      }]);

      console.log('Incoming message saved:', from, body.slice(0, 50));
    }

    // CALL COMPLETED — save basic call record
    if (type === 'call.completed' && data) {
      const from = data.from;
      const to = data.to;
      const duration = data.duration;
      const direction = data.direction;
      const callId = data.id;

      // Find matching client by phone
      const phone = direction === 'inbound' ? from : to;

      await supabase.from('call_transcripts').upsert([{
        call_id: callId,
        phone: phone,
        direction: direction,
        duration_seconds: duration,
        called_at: data.createdAt || new Date().toISOString(),
        status: 'completed'
      }], { onConflict: 'call_id' });

      console.log('Call recorded:', callId, phone, duration + 's');
    }

    // CALL SUMMARY — save AI summary
    if (type === 'call.summary.completed' && data) {
      const callId = data.callId;
      const summary = Array.isArray(data.summary) ? data.summary.join(' ') : (data.summary || '');

      await supabase.from('call_transcripts').upsert([{
        call_id: callId,
        summary: summary,
        status: 'summary_ready'
      }], { onConflict: 'call_id' });

      console.log('Call summary saved:', callId, summary.slice(0, 100));
    }

    // CALL TRANSCRIPT — save full transcript
    if (type === 'call.transcript.completed' && data) {
      const callId = data.callId;
      const dialogue = data.dialogue || [];
      const transcript = dialogue.map(function(line) {
        return (line.identifier || 'Unknown') + ': ' + line.content;
      }).join('\n');

      await supabase.from('call_transcripts').upsert([{
        call_id: callId,
        transcript: transcript,
        status: 'transcript_ready'
      }], { onConflict: 'call_id' });

      console.log('Transcript saved:', callId, transcript.slice(0, 100));
    }

    return res.status(200).json({ received: true, type });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}
