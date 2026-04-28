import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

// ── Activity Logger ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, message, statusOnly } = req.body;
  const QUO_API_KEY = process.env.QUO_API_KEY;
  const QUO_NUMBER  = process.env.QUO_NUMBER;

  try {
    if (statusOnly) {
      const response = await fetchWithTimeout(
        'https://api.openphone.com/v1/phone-numbers',
        { headers: { 'Authorization': QUO_API_KEY } },
        TIMEOUTS.OPENPHONE
      );
      const data = await response.json();
    return res.status(200).json({ success: response.ok, status: response.status, data });
    }

    const invalid = validateOrFail(req.body, SCHEMAS.sendSms);
    if (invalid) return res.status(400).json(invalid);

    let phone = to.replace(/[^0-9+]/g, '');
    if (!phone.startsWith('+')) phone = '+1' + phone;

    const response = await fetchWithTimeout(
      'https://api.openphone.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Authorization': QUO_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: message, from: QUO_NUMBER, to: [phone] })
      },
      TIMEOUTS.OPENPHONE
    );

    const data = await response.json();

    if (!response.ok) {
      await logError('send-sms', `OpenPhone API error: ${response.status}`, {
        to: phone,
        status: response.status,
        response: data
      });
    } else {
      // Log every successful SMS send to activity_logs so it shows in the timeline.
      // Broadcasts don't send SMS, so this naturally only catches per-recipient automations.
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
            action: 'sms_sent',
            description: `SMS to ${phone}: ${(message || '').slice(0, 60)}${(message || '').length > 60 ? '…' : ''}`,
            user_email: 'system',
            entity_type: 'client',
            entity_id: '',
            metadata: { to: phone, message_length: (message || '').length, openphone_id: data?.id },
          }),
        });
      } catch (_) { /* logging failure must not break the send */ }
    }

    return res.status(200).json({ success: response.ok, status: response.status, data });

  } catch (err) {
    await logError('send-sms', err, { to, messageLength: message?.length });
    return res.status(500).json({ success: false, error: err.message });
  }
}
