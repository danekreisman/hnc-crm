import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var leadId = body.leadId;
  var leadData = body.leadData;
  var customPrompt = body.prompt;

  if (!leadId && !leadData && !customPrompt) {
    return res.status(400).json({ success: false, error: 'leadId, leadData, or prompt is required' });
  }

  try {
    var prompt = customPrompt || '';

    if (!prompt && leadData) {
      var name = leadData.name || 'Unknown';
      var svc = leadData.service || 'Unknown';
      var propParts = [];
      if (leadData.beds) propParts.push(leadData.beds + 'br');
      if (leadData.baths) propParts.push(leadData.baths + 'ba');
      if (leadData.sqft) propParts.push(leadData.sqft + ' sqft');
      var property = propParts.length ? propParts.join('/') : 'Unknown';
      var price = leadData.quote_total ? '$' + Number(leadData.quote_total).toFixed(2) : (leadData.value || 'TBD');

      prompt = 'Summarize this cleaning lead for a Hawaii Natural Clean sales rep in 2-3 sentences. Be concise and practical. Focus on what they want and the recommended next action.';
      prompt += ' Name: ' + name + '.';
      prompt += ' Service: ' + svc + '.';
      prompt += ' Property: ' + property + '.';
      if (leadData.condition) prompt += ' Condition: ' + leadData.condition + '/10.';
      prompt += ' Stage: ' + (leadData.stage || 'Unknown') + '.';
      prompt += ' Quoted: ' + price + '.';
      if (leadData.notes) prompt += ' Notes: ' + leadData.notes + '.';
    }

    if (!prompt) return res.status(400).json({ success: false, error: 'Could not build prompt from lead data' });

    var aiRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
    }, TIMEOUTS.ANTHROPIC);

    var aiData = await aiRes.json();
    var summary = aiData.content && aiData.content[0] && aiData.content[0].text;
    if (!summary) throw new Error('No summary returned: ' + JSON.stringify(aiData).slice(0, 200));

    return res.status(200).json({ success: true, summary: summary });
  } catch (err) {
    await logError('ai-summary', err, { leadId: leadId });
    return res.status(500).json({ success: false, error: err.message });
  }
}
