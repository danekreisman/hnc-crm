import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, clientId, clientPhone } = req.body;

  const invalid = validateOrFail(req.body, SCHEMAS.aiSummary);
  if (invalid) return res.status(400).json(invalid);

  try {
    // Enrich the prompt with live OpenPhone conversation history
    let enrichedPrompt = prompt;
    if (clientPhone) {
      const history = await getOpenPhoneHistory(clientPhone, {
        apiKey: process.env.QUO_API_KEY,
        maxSms: 200,
        maxCalls: 25,
      });
      if (history) {
        enrichedPrompt += '\n\nLive conversation history from OpenPhone:\n' + history;
      }
    }

    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: enrichedPrompt }]
        })
      },
      TIMEOUTS.ANTHROPIC,
    );

    const data = await response.json();

    if (!response.ok) {
      await logError('ai-summary', `Anthropic API error: ${response.status}`, {
        status: response.status,
        error: data?.error?.message,
        clientId
      });
      return res.status(502).json({ error: 'AI service unavailable', detail: data?.error?.message });
    }

    const summary = data.content?.[0]?.text || 'Could not generate summary.';
    return res.status(200).json({ summary });

  } catch (err) {
    await logError('ai-summary', err, { clientId, promptLength: prompt?.length });
    return res.status(500).json({ error: err.message });
  }
}
