// Debug endpoint — runs the same AI classifier as openphone-webhook and
// returns the verdict so we can see what the AI is saying for a given message.
// This is for diagnostic use only; safe to leave deployed since it requires
// the ANTHROPIC_API_KEY env var that's already in the project.
//
// Usage:
//   POST /api/debug-classify-message
//   { "body": "we ended up choosing another company", "leadName": "Dane" }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { body, leadName } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  }

  const prompt = [
    'You are classifying a single inbound SMS reply from a sales lead.',
    'The lead may be telling us they chose another company, lost interest, no longer need the service, or are deferring.',
    '',
    `Lead name: ${leadName || 'Unknown'}`,
    `Their reply: "${body}"`,
    '',
    'Classify the intent into ONE of these categories:',
    '  - "lost": clearly indicates they will not use our service. Examples: "we went with someone else", "we ended up choosing another company", "no longer need it", "we hired a different cleaner", "we are not interested", "please remove me from your list", "found another company", "going with [competitor]".',
    '  - "engaged": positive interest, asking questions, wanting to schedule. Examples: "yes lets do it", "what time works", "can we book Tuesday", "i have a question about pricing".',
    '  - "deferred": want service eventually but not now. Examples: "we are going to wait", "maybe next month", "still thinking about it", "after the move", "let me get back to you", "we are going to do it ourselves for now".',
    '  - "unclear": ambiguous, off-topic, or neutral. Default to this if uncertain.',
    '',
    'Confidence levels:',
    '  - "high": clear, unambiguous lost signal',
    '  - "medium": likely lost but some interpretation involved',
    '  - "low": might be lost, might be deferred — coin flip',
    '',
    'Be CONSERVATIVE. False positives are worse than false negatives — we only auto-create a task for "lost" intent at medium or high confidence. When in doubt between lost vs deferred, classify as "deferred". When in doubt between deferred vs unclear, classify as "unclear".',
    '',
    'Return ONLY a JSON object — first character must be { and last must be }. No preamble, no postamble, no markdown fences.',
    'Format: {"intent": "lost"|"engaged"|"deferred"|"unclear", "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}',
  ].join('\n');

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return res.status(500).json({ error: 'Anthropic HTTP ' + aiResp.status, body: errText.slice(0, 500) });
    }
    const aiData = await aiResp.json();
    const text = aiData?.content?.[0]?.text || '';
    if (!text) return res.status(500).json({ error: 'Empty AI response', raw: aiData });

    // Brace-tracking JSON extraction
    const start = text.indexOf('{');
    if (start === -1) return res.status(500).json({ error: 'No JSON in response', raw: text });
    let depth = 0, inString = false, escape = false, jsonStr = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { jsonStr = text.slice(start, i + 1); break; }
      }
    }
    if (!jsonStr) return res.status(500).json({ error: 'Unbalanced JSON', raw: text });
    const verdict = JSON.parse(jsonStr);
    return res.status(200).json({ ok: true, verdict, raw_text: text });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: (err.stack || '').slice(0, 500) });
  }
}
