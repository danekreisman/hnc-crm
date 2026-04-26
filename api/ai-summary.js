import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const leadId = (req.body || {}).leadId;
  const customPrompt = (req.body || {}).prompt;

  if (!leadId && !customPrompt) {
    return res.status(400).json({ success: false, error: 'leadId or prompt is required' });
  }

  try {
    var prompt = customPrompt || '';

    if (!prompt && leadId) {
      var supaUrl = process.env.SUPABASE_URL + '/rest/v1/leads?id=eq.' + leadId + '&select=name,contact_name,service,beds,baths,sqft,condition,notes,stage,address,value,quote_total&limit=1';
      var leadRes = await fetchWithTimeout(supaUrl, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
        }
      }, TIMEOUTS.SUPABASE);
      var leads = await leadRes.json();
      var lead = leads && leads[0];
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

      var name = lead.name || lead.contact_name || 'Unknown';
      var svc = lead.service || 'Unknown';
      var propParts = [];
      if (lead.beds) propParts.push(lead.beds + 'br');
      if (lead.baths) propParts.push(lead.baths + 'ba');
      if (lead.sqft) propParts.push(lead.sqft + ' sqft');
      var property = propParts.length ? propParts.join('/') : 'Unknown';
      var price = lead.quote_total ? '$' + Number(lead.quote_total).toFixed(2) : (lead.value || 'TBD');

      prompt = 'Summarize this cleaning lead for a Hawaii Natural Clean sales rep in 2-3 sentences. Be concise. Focus on what they want and the best next action.';
      prompt += ' Name: ' + name + '.';
      prompt += ' Service: ' + svc + '.';
      prompt += ' Property: ' + property + '.';
      if (lead.condition) prompt += ' Condition: ' + lead.condition + '/10.';
      prompt += ' Stage: ' + (lead.stage || 'Unknown') + '.';
      prompt += ' Quoted: ' + price + '.';
      if (lead.notes) prompt += ' Notes: ' + lead.notes + '.';
    }

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
    if (!summary) throw new Error('No summary returned from Anthropic');

    return res.status(200).json({ success: true, summary: summary });
  } catch (err) {
    await logError('ai-summary', err, { leadId: leadId });
    return res.status(500).json({ success: false, error: err.message });
  }
}
