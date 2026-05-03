/**
 * POST /api/lead-followup-generate
 *
 * Generates AI-personalized follow-up content for a lead.
 *
 * Body: { leadId: string, channels: ('sms'|'email')[] }
 *
 * Returns:
 *   {
 *     success: true,
 *     sms: "Hey Sharon, ..." (only if 'sms' in channels),
 *     email: { subject: "...", body: "..." } (only if 'email' in channels),
 *     leadName: "Sharon Lee",
 *     phone: "+18081234567",
 *     email_addr: "sharon@example.com",
 *     stage: "Quoted",
 *   }
 *
 * Pulls lead row + OpenPhone conversation history (30 SMS + 5 calls), passes
 * to Claude Haiku for fast generation. Tone adapts based on lead stage.
 *
 * No SMS/email is sent here — that's a separate endpoint after the user
 * reviews and approves the message in the preview UI.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require auth
  const _authHdr = req.headers.authorization || '';
  const _token = _authHdr.replace('Bearer ', '').trim();
  if (!_token) return res.status(401).json({ error: 'Unauthorized' });
  const _authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + _token, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!_authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });

  const { leadId, channels } = req.body || {};
  if (!leadId) return res.status(400).json({ error: 'leadId required' });
  const wantSms = Array.isArray(channels) && channels.includes('sms');
  const wantEmail = Array.isArray(channels) && channels.includes('email');
  if (!wantSms && !wantEmail) return res.status(400).json({ error: 'At least one channel required' });

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: lead, error: leadErr } = await db
      .from('leads')
      .select('id,name,contact_name,phone,email,service,sqft,beds,baths,stage,quote_total,quote_data,notes,quote_sent_at,last_responded_at,segment,segment_moved_at,address')
      .eq('id', leadId)
      .maybeSingle();
    if (leadErr || !lead) {
      return res.status(404).json({ error: leadErr?.message || 'Lead not found' });
    }

    // Optional: pull OpenPhone history if phone present
    let history = '';
    if (lead.phone && process.env.QUO_API_KEY) {
      try {
        const phoneE164 = lead.phone.startsWith('+') ? lead.phone : '+1' + lead.phone.replace(/\D/g, '');
        history = await getOpenPhoneHistory(phoneE164, {
          apiKey: process.env.QUO_API_KEY,
          maxSms: 100,
          maxCalls: 5,
        });
      } catch (histErr) {
        console.warn('[lead-followup-generate] OpenPhone history failed:', histErr.message);
      }
    }

    // Scan SMS history for quoted dollar amounts. Catches both formats:
    //   "$385" / "$385.00" / "$ 385" / "385 dollars"
    // Filter for amounts that look like cleaning quotes (>= $50, <= $5000)
    // so we don't pick up phone numbers, zip codes, or stray small numbers.
    const _priceRegex = /\$\s?(\d{2,4}(?:\.\d{1,2})?)\b/g;
    const pricesInHistory = [];
    if (history) {
      let m;
      while ((m = _priceRegex.exec(history)) !== null) {
        const num = parseFloat(m[1]);
        if (num >= 50 && num <= 5000 && pricesInHistory.length < 5) {
          pricesInHistory.push('$' + m[1]);
        }
      }
    }
    const hasPriceEvidence = hasStructuredQuote || pricesInHistory.length > 0;

    // Build the prompt
    const firstName = (lead.name || lead.contact_name || '').split(' ')[0] || 'there';
    const stage = lead.stage || 'New inquiry';
    const service = lead.service || 'a cleaning';
    const quote = lead.quote_total ? `$${Number(lead.quote_total).toFixed(2)}` : null;
    const daysSinceQuote = lead.quote_sent_at
      ? Math.floor((Date.now() - new Date(lead.quote_sent_at).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const hasReplied = !!lead.last_responded_at;
    // Do we have ANY evidence in our records that a quote/estimate was sent?
    // The AI should NOT claim 'the estimate I sent' without evidence — happens
    // a lot for sheet-imported leads where the quote was given verbally over
    // the phone with no SMS trail. The AI may still find a price in the SMS
    // history (also visible in the prompt below), in which case it's free to
    // reference it. This flag only controls the structured CONTEXT signal.
    const hasStructuredQuote = !!(lead.quote_total || lead.quote_sent_at);

    // Extract just the city/town from a full street address. The AI shouldn't
    // mention "100 Malia Uli Pl" — that's creepy. But "your house in Kula" is
    // helpful context. Hawaii addresses typically end with ", <City>, HI <zip>"
    // so we walk backwards from the state to find the city.
    function _extractCity(addr) {
      if (!addr) return null;
      const parts = String(addr).split(',').map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      // Find the part that looks like state ('HI' or 'Hawaii' or 'HI 96789')
      for (let i = parts.length - 1; i > 0; i--) {
        const p = parts[i].toUpperCase();
        if (p === 'HI' || p === 'HAWAII' || /^HI\s+\d{5}/.test(p) || /^HI$/.test(p)) {
          return parts[i - 1] || null;
        }
      }
      // Fallback: if multi-part address, second-to-last is usually city
      if (parts.length >= 2) return parts[parts.length - 2];
      // Single-part: probably already a city name
      return parts[0];
    }
    const city = _extractCity(lead.address);

    // Scan the SMS conversation history for dollar amounts. If the AI has
    // hard evidence a price was quoted (even without a structured DB record),
    // it should be allowed to reference it naturally. Without this signal
    // the AI was over-anchoring on the "Quote on record: NO" line and
    // refusing to reference prices that ARE in the SMS thread.

    const channelInstructions = [];
    if (wantSms) {
      channelInstructions.push(
        [
          'For SMS:',
          '- OPEN with "Aloha [firstName]," — this is the brand voice, not optional. Never "Hey", "Hi", "Hello".',
          '- 1-3 short sentences. Sound like a local Hawaii business owner texting a neighbor, not a sales CRM.',
          '- Sign off "— Dane from Hawaii Natural Clean". Always the full sign-off — do NOT shorten to just "— Dane".',
          '- A 🌺 somewhere is welcome but not required. Do NOT stuff multiple emojis.',
          '- Tone reference (do NOT copy literally — match the warmth, not the words):',
          '   "Aloha Sharon! Hope your move is going smooth. Whenever you\'re ready to lock in that move-out clean, just shoot me a text. — Dane from Hawaii Natural Clean"',
        ].join('\n')
      );
    }
    if (wantEmail) {
      channelInstructions.push(
        [
          'For email:',
          '- OPEN with "Aloha [firstName]," — never "Dear", never "Hi there", never "Hope this email finds you well".',
          '- 3-5 short paragraphs. Warmer and slightly more thorough than SMS, but still feels like the owner personally wrote it — NOT marketing copy.',
          '- Subject line: short, specific to them. Avoid generic "Following up" / "Checking in" / "Just touching base".',
          '- Sign off with "— Dane from Hawaii Natural Clean" on its own line at the end.',
        ].join('\n')
      );
    }

    const stageContext = (() => {
      if (stage === 'New inquiry') return 'They submitted a lead form but have not received a quote yet. Acknowledge their inquiry and confirm you got their request. Aim is to get them to engage so you can follow up with a quote.';
      if (stage === 'Quoted' && hasStructuredQuote && !hasReplied && daysSinceQuote && daysSinceQuote >= 1) return `They got a quote ${daysSinceQuote} days ago and have not responded. Friendly nudge to see if they have questions or want to book.`;
      if (stage === 'Quoted' && hasStructuredQuote && hasReplied) return 'They got a quote and replied at some point. Look at the conversation history for what they actually said and respond to it. Don\'t pretend you haven\'t talked.';
      if (stage === 'Quoted' && !hasStructuredQuote && pricesInHistory.length > 0) return 'Marked Quoted, no structured DB record but prices ARE visible in the SMS history above (and listed in CONTEXT). Reference those prices naturally — they were really quoted to this lead. Friendly nudge to see if they have questions or want to book.';
      if (stage === 'Quoted' && !hasStructuredQuote) return 'Marked Quoted in the system, but I have NO record of an actual estimate being sent — quote may have been verbal/by phone, or just imported from a spreadsheet. DO NOT claim to have sent an estimate or reference a specific quote. Be open-ended: "wanted to make sure you had everything you need to decide", "let me know if any questions came up", "happy to walk through pricing again whenever". Aim is to re-engage without making up history.';
      if (stage === 'Follow-up' && hasPriceEvidence) return 'Cold lead — they got a quote (or prices were discussed by SMS) but went silent. Light, no-pressure check-in. If a price is on record or visible in SMS history, you may reference it. Don\'t guilt them. The aim is to leave the door open without being pushy.';
      if (stage === 'Follow-up' && !hasPriceEvidence) return 'Cold lead, but I do NOT have a record of a structured estimate being sent and no prices appear in SMS history. May have been a phone-only conversation. DO NOT claim to have sent an estimate. Open-ended re-engagement only: "wanted to circle back about your cleaning needs", "let me know if there\'s anything I can help you sort out". Reference details from the SMS/call history if any exist; otherwise keep it short and general.';
      if (stage === 'Closed lost') return 'This was marked lost — try to re-engage gently. Maybe they had a reason that\'s no longer true.';
      return 'Generic follow-up. Be friendly and specific.';
    })();

    // Today's date in Hawaii time, formatted readably for the AI. Without this
    // the model can hallucinate that a date mentioned in old SMS history is
    // still upcoming when it has actually passed.
    const todayHawaii = new Date().toLocaleDateString('en-US', {
      timeZone: 'Pacific/Honolulu',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const prompt = [
      'You are writing a personalized follow-up message from Dane, owner of Hawaii Natural Clean (a cleaning business in Hawaii) to a sales lead.',
      '',
      `TODAY'S DATE: ${todayHawaii} (Hawaii time)`,
      '',
      'CONTEXT:',
      `- Lead: ${lead.name || 'Unknown'}`,
      `- Stage: ${stage}`,
      `- Service interested in: ${service}`,
      city ? `- General area: ${city} (you may reference this — e.g. "your home in ${city}". Do NOT mention any street name, street number, or apartment.)` : '',
      hasStructuredQuote
        ? `- Quote on record: ${quote || 'yes (amount not stored)'}`
        : (pricesInHistory.length > 0
          ? `- Quote on record: not in our database, BUT prices visible in SMS history: ${pricesInHistory.join(', ')}. These were quoted to this lead by SMS — you may reference them naturally.`
          : '- Quote on record: NO — no structured quote AND no prices in the SMS history. Do NOT claim to have sent an estimate or invent any price.'),
      daysSinceQuote != null ? `- Days since quote: ${daysSinceQuote}` : '',
      hasReplied ? `- They have replied at some point (see conversation)` : '- They have NOT replied since the quote was sent',
      lead.notes ? `- Notes: ${lead.notes}` : '',
      '',
      'STAGE-SPECIFIC GUIDANCE: ' + stageContext,
      '',
      'CHANNEL INSTRUCTIONS:',
      ...channelInstructions,
      '',
      'GENERAL RULES:',
      '- BRAND VOICE: Hawaii Natural Clean is a small, locally-owned cleaning business on Oahu and Maui. Owner Dane writes these personally. Voice is warm, neighborly, a little island-flavored — never corporate, never pushy. The reader should feel like a real person remembered them, not a CRM.',
      `- Address them as "${firstName}", not their full name.`,
      '- Be specific. If their notes or conversation history mention something concrete (a date, a property type, a question they asked), reference it.',
      '- BANNED PHRASES (these are CRM-speak, not how locals talk): "just checking in", "checking in on", "following up on that", "wanted to follow up", "wanted to reach out", "circling back", "touching base", "I hope this finds you well", "I hope this email finds you well", "per our last conversation".',
      '- BANNED OPENERS: "Hey", "Hi", "Hello", "Dear", "Hi there". Always open with "Aloha [firstName],".',
      '- Do NOT make up details that aren\'t in the data above. If you don\'t have a specific hook, keep it short and warm — better a 2-sentence message that feels real than a 5-sentence message stuffed with invented context.',
      '- ESTIMATES & PRICES — CRITICAL: Only reference an estimate or quote if there is direct evidence one was sent. Two valid sources: (1) "Quote on record: $X" in CONTEXT above, OR (2) a clear dollar amount in the SMS/call history. If neither exists, you have NO evidence an estimate was sent. In that case do NOT use phrases like "the estimate I sent", "your quote", "checking in on the estimate", "the price I gave you", "the quote we discussed in [month]". The lead may have only had a phone or in-person conversation, OR they may be a sheet-imported lead with no actual estimate ever sent. Use open-ended phrasing instead: "your inquiry", "your interest", "your move-out cleaning needs", "wanted to make sure you had everything to decide", "happy to walk through pricing whenever".',
      '- When you DO have evidence of a price: reference it naturally — "the $385 we talked about" or "the move-out estimate" — never robotically as "your quote" or "the quote".',
      '- NEVER invent a price. Never make up a dollar amount.',
      '- DATES — CRITICAL: Today\'s date is at the top of this prompt. NEVER suggest, confirm, or invite the lead to book on a date that has already passed. If the SMS history contains a proposed date (e.g. "Are you available May 5th?") and that date is in the past, treat it as expired — DO NOT reference that specific date as bookable. You can say "the date we discussed didn\'t work out" or "wanted to try and reschedule" or just leave dates out entirely. Future dates and open-ended phrasing ("whenever works for you", "this week", "anytime soon") are fine.',
      '- Do NOT invent any specific date the lead never proposed. "Are you free Tuesday?" is invented if Tuesday wasn\'t mentioned in the conversation history.',
      '- ADDRESSES — IMPORTANT: You may reference the city, town, or general area (e.g. "your home in Kula", "your place in Mililani"). Cities are friendly local context. You may NOT mention any street number, street name, apartment number, building name, or zip code. NEVER write something like "100 Malia Uli Pl" or "your place on Kalakaua Ave" — that\'s creepy and inappropriate. If only a full address is available and you want to reference location, fall back to the city/town only.',
      '',
      'CHECKLIST before you write the message:',
      '  ✓ Does it open with "Aloha"?',
      '  ✓ Does it AVOID every banned phrase?',
      '  ✓ Would it feel natural coming from a small business owner who knows the islands?',
      '  ✓ If you stripped the lead\'s name out, would it still feel like ME wrote it (vs. any cleaning company)?',
      '  ✓ If the message references any specific date, is that date today or in the future (NEVER in the past)?',
      '  ✓ If the message references "the estimate I sent" or "your quote" or any specific dollar amount — is that supported by the CONTEXT block or the SMS history? If not, REWRITE without that claim.',
      '  ✓ Does the message mention any street number, street name, apartment number, or zip code? If yes, REWRITE — only use the city/town if location matters.',
      '',
      history && history.trim() ? '\n=== CONVERSATION HISTORY (most recent first) ===\n' + history + '\n=== END HISTORY ===\n' : '',
      'OUTPUT FORMAT (STRICT):',
      'Return ONLY a JSON object — nothing else. No "Here\'s the message:" preamble. No "Note:" or "Hope this helps" postamble. No markdown code fences (```). No commentary about your choices. The very first character of your response must be `{` and the very last character must be `}`.',
      wantSms && wantEmail ? '{"sms": "<sms text>", "email": {"subject": "<subject>", "body": "<body>"}}' : '',
      wantSms && !wantEmail ? '{"sms": "<sms text>"}' : '',
      !wantSms && wantEmail ? '{"email": {"subject": "<subject>", "body": "<body>"}}' : '',
    ].filter(Boolean).join('\n');

    const aiRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 30000);

    const aiData = await aiRes.json();
    const text = aiData?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned empty response');

    // Parse JSON, robust against:
    //   - leading/trailing prose ("Here's the message:" before, "Note:" after)
    //   - markdown code fences
    //   - the AI returning multiple JSON objects back-to-back
    //   - braces inside string values (e.g. literal {}'s in the SMS text)
    // Strategy: walk forward from the first '{', tracking brace depth and
    // string boundaries, return the first balanced {...} block. This is way
    // more reliable than indexOf/lastIndexOf which gets confused by braces
    // inside strings or trailing content.
    function _extractFirstJsonObject(s) {
      const start = s.indexOf('{');
      if (start === -1) return null;
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
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
          if (depth === 0) return s.slice(start, i + 1);
        }
      }
      return null; // unbalanced
    }

    const stripped = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
    const cleaned = _extractFirstJsonObject(stripped) || stripped;

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      console.error('[lead-followup-generate] JSON parse failed.\n  Raw:', text, '\n  Cleaned:', cleaned);
      throw new Error('AI response was not valid JSON: ' + e.message);
    }

    return res.status(200).json({
      success: true,
      sms: wantSms ? (parsed.sms || '') : null,
      email: wantEmail ? (parsed.email || { subject: '', body: '' }) : null,
      leadName: lead.name || lead.contact_name || '',
      phone: lead.phone || '',
      email_addr: lead.email || '',
      stage,
    });
  } catch (err) {
    await logError('lead-followup-generate', err, { leadId });
    return res.status(500).json({ error: err.message });
  }
}
