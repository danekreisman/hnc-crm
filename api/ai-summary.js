import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';
import { buildSummaryPrompt } from './utils/summary-prompt.js';

/**
 * POST /api/ai-summary
 *
 * Two modes:
 *
 * 1) Structured (preferred — what the new front-end uses):
 *    {
 *      mode: 'lead' | 'client',
 *      data: { name, service, stage, beds, baths, sqft, condition, quote_total,
 *              address, notes, ltv, mrr, last_job, next_job, cleaner, payment,
 *              properties, recent_jobs, recent_messages, type, status,
 *              frequency, since, property },
 *      phone: '+18081234567'  // optional — when present, OpenPhone SMS+call
 *                                history is fetched server-side and fed in
 *    }
 *
 * 2) Legacy (kept for backwards compat):
 *    { prompt: '...', clientPhone: '...' }    — runs the prompt as-is.
 *    { leadId, leadData: {...} }              — auto-builds the old short prompt.
 *
 * Always returns: { success: true, summary: '...markdown...', generated_at, model }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { mode, data, phone, prompt: customPrompt, clientPhone, leadId, leadData } = body;

  if (!mode && !data && !customPrompt && !leadId && !leadData) {
    return res.status(400).json({ success: false, error: 'mode+data, prompt, or leadData is required' });
  }

  try {
    let finalPrompt = '';
    let usedHistory = false;

    if (mode && data) {
      let history = '';
      const phoneToFetch = phone || clientPhone;
      if (phoneToFetch && process.env.QUO_API_KEY) {
        try {
          // User-triggered endpoint — keep history bounded so the summary lands
          // in a couple seconds. The VA pre-call brief (run-task-automations.js)
          // pulls the full 100/10 since it's a background cron.
          history = await getOpenPhoneHistory(phoneToFetch, {
            apiKey: process.env.QUO_API_KEY,
            maxSms: 30,
            maxCalls: 5,
          });
          if (history && history.length) usedHistory = true;
        } catch (histErr) {
          console.warn('[ai-summary] OpenPhone history fetch failed:', histErr.message);
        }
      }
      finalPrompt = buildSummaryPrompt({ mode, data, history });
    } else if (customPrompt) {
      finalPrompt = customPrompt;
    } else if (leadData) {
      const name = leadData.name || 'Unknown';
      const svc = leadData.service || 'Unknown';
      const propParts = [];
      if (leadData.beds) propParts.push(leadData.beds + 'br');
      if (leadData.baths) propParts.push(leadData.baths + 'ba');
      if (leadData.sqft) propParts.push(leadData.sqft + ' sqft');
      const property = propParts.length ? propParts.join('/') : 'Unknown';
      const price = leadData.quote_total ? '$' + Number(leadData.quote_total).toFixed(2) : (leadData.value || 'TBD');
      finalPrompt = 'Summarize this cleaning lead for a Hawaii Natural Clean sales rep in 2-3 sentences. Be concise and practical. Focus on what they want and the recommended next action.'
        + ' Name: ' + name + '.'
        + ' Service: ' + svc + '.'
        + ' Property: ' + property + '.'
        + (leadData.condition ? ' Condition: ' + leadData.condition + '/10.' : '')
        + ' Stage: ' + (leadData.stage || 'Unknown') + '.'
        + ' Quoted: ' + price + '.'
        + (leadData.notes ? ' Notes: ' + leadData.notes + '.' : '');
    }

    if (!finalPrompt) return res.status(400).json({ success: false, error: 'Could not build prompt' });

    const useStructured = !!(mode && data);
    // User-triggered endpoint runs Haiku for speed (target: 2-5s land time even
    // with 30 SMS + 5 calls of OpenPhone history). Sonnet 4.6 was technically
    // capable but consistently 15-25s for long-time customers — too slow for a
    // button click. The VA pre-call brief in run-task-automations.js still uses
    // Sonnet because it's a background cron and quality > latency there.
    const aiTimeout = useStructured ? 30000 : TIMEOUTS.ANTHROPIC;
    const aiRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: useStructured ? 1000 : 300,
        messages: [{ role: 'user', content: finalPrompt }],
      }),
    }, aiTimeout);

    const aiData = await aiRes.json();
    const summary = aiData.content && aiData.content[0] && aiData.content[0].text;
    if (!summary) throw new Error('No summary returned: ' + JSON.stringify(aiData).slice(0, 200));

    return res.status(200).json({
      success: true,
      summary,
      generated_at: new Date().toISOString(),
      used_openphone_history: usedHistory,
      model: 'claude-haiku-4-5-20251001',
    });
  } catch (err) {
    await logError('ai-summary', err, { leadId, mode });
    return res.status(500).json({ success: false, error: err.message });
  }
}
