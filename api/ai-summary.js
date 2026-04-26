import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt: rawPrompt, leadId, clientId, clientPhone } = req.body;

  const invalid = validateOrFail(req.body, SCHEMAS.aiSummary);
  if (invalid) return res.status(400).json(invalid);

  if (!rawPrompt && !leadId) {
    return res.status(400).json({ success: false, error: 'Either prompt or leadId is required' });
  }

  let prompt = rawPrompt;

  try {
    if (!prompt && leadId) {
      const supaRes = await fetchWithTimeout(
        `${process.env.SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}&select=name,service,beds,baths,sqft,condition,notes,stage,address,created_at&limit=1`,
        {
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          }
        },
        TIMEOUTS.SUPABASE
      );

      if (!supaRes.ok) {
        await logError('ai-summary', `Supabase fetch error: ${supaRes.status}`, { leadId });
        return res.status(502).json({ error: 'Failed to fetch lead data' });
      }

      const leads = await supaRes.json();
      const lead = leads[0];

      if (!lead) {
        return res.status(404).json({ error: 'Lead not found' });
      }

      prompt = `Summarize this cleaning lead for a Hawaii Natural Clean sales rep in 2-3 sentences. Focus on what they want, their property details, and the recommended next action. Lead name: ${lead.name}. Service: ${lead.service}. Property: ${lead.beds}br/${lead.baths}ba, ${lead.sqft} sqft, condition ${lead.condition}/10. Stage: ${lead.stage}. Address: ${lead.address}. Notes: ${lead.notes}.`;
    }

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
    await logError('ai-summary', err, { clientId, leadId, promptLength: prompt?.length });
    return res.status(500).json({ error: err.message });
  }
}
