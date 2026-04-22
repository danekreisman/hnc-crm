import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, clientId } = req.body;

  const invalid = validateOrFail(req.body, SCHEMAS.aiSummary);
  if (invalid) return res.status(400).json(invalid);

  try {
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
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }]
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
