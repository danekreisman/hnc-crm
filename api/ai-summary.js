import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const leadId = body.leadId;
  const customPrompt = body.prompt;

  if (!leadId && !customPrompt) {
    return res.status(400).json({ success: false, error: 'leadId or prompt is required' });
  }

  try {
    let prompt = customPrompt || '';

    if (!prompt && leadId) {
      const leadUrl = process.env.SUPABASE_URL + '/rest/v1/leads?id=eq.' + leadId + '&select=name,contact_name,service,beds,baths,sqft,condition,notes,stage,address,value,quote_total&limit=1';
      const leadRes = await fetchWithTimeout(leadUrl, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
        }
      }, TIMEOUTS.SUPABASE);
      const leads = await leadRes.json();
      const lead = leads && leads[0];
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

      const name = lead.name || lead.contact_name || 'Unknown';
      const svc = lead.service || 'Unknown';
      const beds = lead.beds ? lead.beds + 'br' : '';
      const baths = lead.baths ? lead.baths + 'ba' : '';
      const sqft = lead.sqft ? lead.sqft + ' sqft' : '';
      const property = [beds, baths, sqft].filter(Boolean).join('/') || 'Unknown';
      const cond = lead.condition ? 'Condition: ' + lead.condition + '/10. ' : '';
      const price = lead.quote_total ? '$' + Number(lead.quote_total).toFixed(2) : (lead.value || 'TBD');
      const notes = lead.notes || 'None';
      const stage = lead.stage || 'Unknown';
      const address = lead.address || 'Not provided';

      prompt = 'Summarize this cleaning lead for a Hawaii Natural Clean sales rep in 2-3 sentences. Be concise and practical. Focus on what they want and the best next action.

Name: ' + name + '
Service: ' + svc + '
Property: ' + property + '
' + cond + 'Stage: ' + stage + '
Quoted price: ' + price + '
Address: ' + address + '
Notes: ' + notes;
    }

    const anthropicRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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

    const data = await anthropicRes.json();
    const summary = data.content && data.content[0] && data.content[0].text;
    if (!summary) throw new Error('No summary returned');

    return res.status(200).json({ success: true, summary });
  } catch (err) {
    await logError('ai-summary', err, { leadId });
    return res.status(500).json({ success: false, error: err.message });
  }
}
