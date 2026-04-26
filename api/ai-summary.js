import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { leadId, prompt: customPrompt } = req.body || {};

  if (!leadId && !customPrompt) {
    return res.status(400).json({ success: false, error: 'leadId or prompt is required' });
  }

  try {
    let prompt = customPrompt;

    if (!prompt && leadId) {
      // Fetch lead data from Supabase
      const leadRes = await fetchWithTimeout(
        process.env.SUPABASE_URL + '/rest/v1/leads?id=eq.' + leadId + '&select=name,contact_name,phone,email,service,beds,baths,sqft,condition,notes,stage,address,created_at,value,quote_total&limit=1',
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY } },
        TIMEOUTS.SUPABASE
      );
      const leads = await leadRes.json();
      const lead = leads && leads[0];
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

      const property = [lead.beds ? lead.beds + 'br' : null, lead.baths ? lead.baths + 'ba' : null, lead.sqft ? lead.sqft + ' sqft' : null].filter(Boolean).join('/');
      const price = lead.quote_total ? '$' + Number(lead.quote_total).toFixed(2) : (lead.value || 'TBD');

      prompt = 'Summarize this cleaning lead for a Hawaii Natural Clean sales rep in 2-3 sentences. Focus on what they want, their property, and the best next action. Be concise and practical.

Lead: ' + (lead.name || lead.contact_name || 'Unknown') + '
Service: ' + (lead.service || 'Unknown') + '
Property: ' + (property || 'Unknown') + (lead.condition ? ', condition ' + lead.condition + '/10' : '') + '
Stage: ' + (lead.stage || 'Unknown') + '
Quoted: ' + price + '
Address: ' + (lead.address || 'Not provided') + '
Notes: ' + (lead.notes || 'None') + '
Inquiry date: ' + (lead.created_at ? lead.created_at.slice(0, 10) : 'Unknown');
    }

    // Call Anthropic
    const anthropicRes = await fetchWithTimeout(
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
      TIMEOUTS.ANTHROPIC
    );

    const data = await anthropicRes.json();
    const summary = data.content && data.content[0] && data.content[0].text;
    if (!summary) throw new Error('No summary returned from Anthropic');

    return res.status(200).json({ success: true, summary });
  } catch (err) {
    await logError('ai-summary', err, { leadId });
    return res.status(500).json({ success: false, error: err.message });
  }
}
