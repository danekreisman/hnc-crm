import { isWebhookProcessed, recordWebhook } from './utils/webhook-idempotency.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'OpenPhone webhook receiver active' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';
  // Use the service role key — this is a server-side webhook with no user
  // context. The anon key was getting blocked by RLS on the tasks table
  // (and could hit similar issues on other tables in the future). Service
  // role bypasses RLS, which is the correct security model for trusted
  // server-side endpoints. Falls back to anon key if service role isn't
  // set so an env-var typo doesn't take the webhook completely offline.
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  async function supabaseInsert(table, data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(data)
    });
    return res;
  }

  async function supabaseUpsert(table, data, onConflict) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(data)
    });
    return res;
  }

  async function findClientByPhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (digits.length < 10) return null;
    /* Query Supabase directly using the last-10-digits suffix instead of
       fetching the first 100 rows and filtering client-side. The old
       approach silently failed once the table grew beyond the limit —
       any client outside the first 100 was unmatched. The wildcard
       prefix `%` lets us match phones stored with country codes,
       formatting, etc. We sort by id desc just for determinism if
       multiple rows share the same trailing digits. */
    const res = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=id,name,phone&phone=ilike.%25${digits}&limit=5`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const clients = await res.json();
    if (!Array.isArray(clients) || clients.length === 0) return null;
    /* Defensive double-check on last-10-digits in case the ilike matched
       a longer/shorter number that happened to contain the suffix as a
       substring (e.g. someone's phone ending in our search digits + extra). */
    return clients.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === digits) || null;
  }

  async function findLeadByPhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (digits.length < 10) return null;
    /* Same fix as findClientByPhone — query by phone suffix instead of
       pulling N rows and filtering. The old `limit=200` meant any lead
       past the 200th most-recent would never be matched (so any reply
       from an older lead was silently ignored — which is what was
       happening to William). */
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?select=id,name,phone,response_count&phone=ilike.%25${digits}&limit=5`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const leads = await res.json();
    if (!Array.isArray(leads) || leads.length === 0) return null;
    return leads.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === digits) || null;
  }

  /**
   * Classify a lead's inbound SMS using Claude Haiku to detect lost-intent.
   * Cheap (~$0.001/call) and fast. Returns { intent, confidence, reasoning }
   * where intent is 'lost' | 'engaged' | 'deferred' | 'unclear' and
   * confidence is 'high' | 'medium' | 'low'. We only act on 'lost' with
   * non-low confidence — everything else just goes to the inbox. False
   * positives are worse than false negatives (we'd hide a real customer),
   * so the prompt is intentionally conservative.
   */
  async function classifyLeadResponse(messageBody, leadName) {
    const prompt = [
      'You are classifying a single inbound SMS reply from a sales lead.',
      'The lead may be telling us they chose another company, lost interest, no longer need the service, or are deferring.',
      '',
      `Lead name: ${leadName || 'Unknown'}`,
      `Their reply: "${messageBody}"`,
      '',
      'Classify the intent into ONE of these categories:',
      '  - "lost": clearly indicates they will not use our service. Examples: "we went with someone else", "we ended up choosing another company", "no longer need it", "we hired a different cleaner", "we are not interested", "please remove me from your list".',
      '  - "engaged": positive interest, asking questions, wanting to schedule. Examples: "yes lets do it", "what time works", "can we book Tuesday", "i have a question about pricing".',
      '  - "deferred": want service eventually but not now. Examples: "we are going to wait", "maybe next month", "still thinking about it", "after the move", "let me get back to you".',
      '  - "unclear": ambiguous, off-topic, or neutral. Default to this if uncertain.',
      '',
      'Confidence levels:',
      '  - "high": clear, unambiguous lost signal',
      '  - "medium": likely lost but some interpretation involved',
      '  - "low": might be lost, might be deferred — coin flip',
      '',
      'Be CONSERVATIVE. False positives are worse than false negatives — we only auto-create a task for "lost" intent at medium or high confidence. When in doubt, classify as "unclear" or "deferred".',
      '',
      'Return ONLY a JSON object — first character must be { and last must be }. No preamble, no postamble, no markdown.',
      'Format: {"intent": "lost"|"engaged"|"deferred"|"unclear", "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}',
    ].join('\n');

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
    if (!aiResp.ok) throw new Error('Anthropic API HTTP ' + aiResp.status);
    const data = await aiResp.json();
    const text = data?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned empty response');

    // Brace-tracking JSON extractor — same pattern used in lead-followup-generate.
    // Avoids indexOf/lastIndexOf brittleness when the model adds preamble or postamble.
    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON in AI response');
    let depth = 0, inString = false, escape = false, jsonStr = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) { if (ch === '\\') { escape = true; continue; } if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonStr = text.slice(start, i + 1); break; } }
    }
    if (!jsonStr) throw new Error('Unbalanced JSON in AI response');
    return JSON.parse(jsonStr);
  }

  /**
   * Classify an inbound call's transcript: is this a real lead inquiry, and
   * if so, what fields can we pre-fill on the lead form?
   *
   * Used by `call.transcript.completed` to auto-create a `review_call_lead`
   * task. False positives waste Dane's time clicking "Not a lead"; false
   * negatives leak revenue. We err toward conservative (only flag clear
   * lead signals) — Dane can always log a missed lead manually.
   *
   * Returns {
   *   is_lead: boolean,
   *   confidence: 'high'|'medium'|'low',
   *   extracted: { name, service, address, beds, baths, sqft, condition, frequency, notes },
   *   reasoning: string
   * }
   *
   * Extracted fields use null when uncertain — never hallucinate addresses
   * or property details. The notes field captures anything the caller said
   * that doesn't fit a structured field but matters (timeline, special
   * requests, who they are, etc).
   */
  async function classifyAndExtractCallLead({ transcript, summary, callerPhone, durationSeconds }) {
    const callContext = [
      callerPhone ? `Caller phone: ${callerPhone}` : '',
      durationSeconds ? `Duration: ${durationSeconds}s` : '',
      summary ? `OpenPhone-generated summary: ${summary}` : '',
    ].filter(Boolean).join('\n');

    const transcriptBlock = transcript ? `\n=== CALL TRANSCRIPT ===\n${transcript}\n=== END TRANSCRIPT ===` : '';

    const prompt = [
      'You are classifying an inbound phone call to Hawaii Natural Clean (a residential and commercial cleaning business in Hawaii). Your job is two-fold:',
      '  (1) Decide if this caller is a real lead — someone inquiring about cleaning services for themselves or their property.',
      '  (2) If they are, extract the lead fields you can confidently parse from what was actually said.',
      '',
      'NOT a lead (is_lead = false):',
      '  - Other cleaners or service providers pitching us',
      '  - Sales/marketing/advertising calls',
      '  - Wrong number, accidental dial, hangup',
      '  - Existing customer calling about an existing booking (those should be handled separately)',
      '  - Vendor calls (suppliers, accountants, etc)',
      '  - Robocalls / spam',
      '',
      'IS a lead (is_lead = true):',
      '  - Caller asks about cleaning service, pricing, availability, or scheduling',
      '  - Caller describes a property they want cleaned (home, rental, office, etc)',
      '  - Caller is referred by someone and wants a quote',
      '  - Caller is asking for general info but clearly looking to hire',
      '',
      'Confidence:',
      '  - "high": unambiguous lead inquiry, clear service ask',
      '  - "medium": probably a lead but some ambiguity',
      '  - "low": coin flip — leaning lead but could be junk. We will NOT auto-create a task at low confidence; default to is_lead=false instead unless you are at least medium-confident.',
      '',
      'EXTRACTION RULES (only apply if is_lead=true):',
      '  - name: caller\'s name if stated. Null if not mentioned. Do NOT guess from caller ID.',
      '  - service: one of "Regular Cleaning", "Deep Cleaning", "Move-out Cleaning", "Move-in Cleaning", "Commercial Cleaning", "Janitorial Cleaning", "Vacation Rental Cleaning". Null if unclear.',
      '  - address: full address if stated. Null if only neighborhood/island given (put that in notes instead). NEVER hallucinate — leave null if uncertain.',
      '  - beds: number of bedrooms if stated (e.g. "3"). Null otherwise.',
      '  - baths: number of bathrooms if stated. Null otherwise.',
      '  - sqft: square footage if stated. Null otherwise.',
      '  - condition: one of "Pristine", "Decent", "Moderately dirty", "Very dirty", "Extreme" if the caller described the property\'s condition. Null otherwise.',
      '  - frequency: one of "One-time", "Weekly", "Biweekly", "Monthly" if stated. Null otherwise.',
      '  - notes: a short 1-3 sentence summary of who they are, what they need, timeline, and any special requests or context not captured above. Empty string if nothing extra.',
      '  - quote_amount: if the rep verbally quoted a SPECIFIC dollar figure during the call (e.g. "I can do that for $245", "the total comes out to four hundred fifty"), extract the number as a JSON number (no $ sign, no commas). Null if no specific price was given. Soft estimates ("ballpark", "starting around", "somewhere between") should be null — only extract committed prices.',
      '  - quote_confidence: "high" | "medium" | "low" | "none" — how confident you are that a SPECIFIC quote was given. "none" if quote_amount is null. We treat low as null on the consumer side.',
      '',
      'Return ONLY a JSON object — first character must be { and last must be }. No preamble, no postamble, no markdown.',
      'Format:',
      '{"is_lead": <bool>, "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>", "extracted": {"name": <string|null>, "service": <string|null>, "address": <string|null>, "beds": <string|null>, "baths": <string|null>, "sqft": <string|null>, "condition": <string|null>, "frequency": <string|null>, "notes": <string>, "quote_amount": <number|null>, "quote_confidence": "high"|"medium"|"low"|"none"}}',
      '',
      '=== CALL CONTEXT ===',
      callContext || '(no metadata available)',
      transcriptBlock,
    ].join('\n');

    const aiResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
    }, TIMEOUTS.ANTHROPIC);
    if (!aiResp.ok) throw new Error('Anthropic API HTTP ' + aiResp.status);
    const data = await aiResp.json();
    const text = data?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned empty response');

    // Same brace-tracking JSON extractor as classifyLeadResponse — robust to
    // pre/postamble even when the prompt explicitly forbids it.
    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON in AI response');
    let depth = 0, inString = false, escape = false, jsonStr = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) { if (ch === '\\') { escape = true; continue; } if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonStr = text.slice(start, i + 1); break; } }
    }
    if (!jsonStr) throw new Error('Unbalanced JSON in AI response');
    return JSON.parse(jsonStr);
  }

  /**
   * Quote-only extractor for transcripts where the caller is already a known
   * lead (so the call-lead classifier doesn't run). Returns a small JSON
   * with whether a specific dollar quote was given and the amount.
   *
   *   { quote_discussed: bool, amount: number|null,
   *     confidence: 'high'|'medium'|'low', reasoning: string }
   *
   * Conservative by design — false positives spam Dane with confirm-quote
   * tasks that don't represent real quotes. We only act on medium+.
   */
  async function extractQuoteFromTranscript({ transcript, summary, leadName, durationSeconds }) {
    const ctx = [
      leadName ? `Existing lead on the call: ${leadName}` : '',
      durationSeconds ? `Call duration: ${durationSeconds}s` : '',
      summary ? `OpenPhone-generated summary: ${summary}` : '',
    ].filter(Boolean).join('\n');

    const transcriptBlock = transcript
      ? `\n=== CALL TRANSCRIPT ===\n${transcript}\n=== END TRANSCRIPT ===`
      : '';

    const prompt = [
      'You are reviewing a call transcript between Hawaii Natural Clean (a residential and commercial cleaning business) and an existing lead. Your only job is to detect whether the rep gave the lead a SPECIFIC dollar quote during the call.',
      '',
      'Return quote_discussed=true ONLY if the rep stated a specific committed price the lead can act on, e.g. "I can do that for $245", "the total comes out to four hundred fifty", "$60 per hour for an estimated 4 hours so $240".',
      '',
      'Return quote_discussed=false if:',
      '  - No price was discussed at all',
      '  - Only a soft estimate ("ballpark", "starting around", "somewhere between $200 and $300", "I\'d need to see it first")',
      '  - The lead asked about price but the rep deflected ("we\'ll need to do a walkthrough", "send me your address")',
      '  - The rep quoted a price but immediately retracted or revised it without committing',
      '',
      'Confidence:',
      '  - "high": rep clearly stated a single dollar figure as THE price',
      '  - "medium": price was given but with some hedging — still actionable',
      '  - "low": ambiguous, probably worth a manual review',
      '',
      'Amount: extract as a JSON number (no $ sign, no commas). If a range was given AND committed (rare — usually unrealistic), use the lower bound. Null if quote_discussed=false.',
      '',
      'Return ONLY a JSON object — first character must be { and last must be }. No preamble, no markdown.',
      'Format: {"quote_discussed": <bool>, "amount": <number|null>, "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}',
      '',
      '=== CALL CONTEXT ===',
      ctx || '(no metadata available)',
      transcriptBlock,
    ].join('\n');

    const aiResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, TIMEOUTS.ANTHROPIC);
    if (!aiResp.ok) throw new Error('Anthropic API HTTP ' + aiResp.status);
    const data = await aiResp.json();
    const text = data?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned empty response');

    // Same brace-tracking JSON extractor as the other classifiers.
    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON in AI response');
    let depth = 0, inString = false, escape = false, jsonStr = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) { if (ch === '\\') { escape = true; continue; } if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonStr = text.slice(start, i + 1); break; } }
    }
    if (!jsonStr) throw new Error('Unbalanced JSON in AI response');
    return JSON.parse(jsonStr);
  }

  /**
   * SMS-specific lead extractor. Tide Phase 7 (2026-05-07).
   *
   * Single-message version of classifyAndExtractCallLead. Called when an
   * inbound SMS arrives from an unknown number (not a lead, not a client)
   * with at least 20 characters of body. Classifies whether it's a real
   * cleaning inquiry and extracts whatever lead fields are inferable from
   * the message text.
   *
   * Returns same shape as classifyAndExtractCallLead so downstream task
   * creation can reuse the same flow:
   *   { is_lead: bool, confidence, extracted: {...}, reasoning }
   */
  async function classifyAndExtractSmsLead({ messageBody, senderPhone }) {
    const prompt = [
      'You are classifying an inbound SMS to Hawaii Natural Clean (a residential and commercial cleaning business in Hawaii). Your job is two-fold:',
      '  (1) Decide if this sender is a real lead - someone inquiring about cleaning services for themselves or their property.',
      '  (2) If they are, extract whatever lead fields you can confidently parse from what was actually said. SMS messages are short - most fields will be null.',
      '',
      'NOT a lead (is_lead = false):',
      '  - Other cleaners or service providers pitching us',
      '  - Sales/marketing/advertising spam',
      '  - Wrong number ("sorry wrong number")',
      '  - Existing customer messaging about an existing booking',
      '  - Vendor messages (suppliers, accountants, etc)',
      '  - Personal messages clearly not about cleaning ("hey what time u free")',
      '  - Generic test messages, "test", single emojis, etc.',
      '',
      'IS a lead (is_lead = true):',
      '  - Asks about cleaning service or pricing',
      '  - Mentions a property type (house, condo, airbnb, apartment, office) in context of wanting it cleaned',
      '  - Mentions move-out / move-in / deep clean / regular cleaning interest',
      '  - References our website/ad/referral and asks for info',
      '',
      'Confidence:',
      '  - "high": clear cleaning inquiry with specifics (property type, location, or scope)',
      '  - "medium": cleaning intent is implied but vague',
      '  - "low": ambiguous - could go either way',
      '',
      'Only is_lead=true with confidence != low will create a task. Low-confidence leads are silently skipped.',
      '',
      'Extracted fields (set to null when uncertain - never hallucinate):',
      '  - name: sender name if mentioned in the message',
      '  - service: one of "Move-out Cleaning", "Deep Cleaning", "Regular Cleaning", "Airbnb Turnover", "Janitorial Cleaning", or null',
      '  - address: full or partial address if mentioned',
      '  - beds: integer if mentioned',
      '  - baths: number if mentioned',
      '  - sqft: integer if mentioned',
      '  - frequency: weekly/biweekly/monthly/one-time if mentioned',
      '  - notes: anything the sender said that doesn\'t fit other fields but matters (timeline, special requests, who they are)',
      '',
      'Return ONLY a JSON object - first character must be { and last must be }. No preamble, no markdown.',
      'Format: {"is_lead": <bool>, "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>", "extracted": {"name": <string|null>, "service": <string|null>, "address": <string|null>, "beds": <int|null>, "baths": <number|null>, "sqft": <int|null>, "frequency": <string|null>, "notes": <string|null>}}',
      '',
      `Sender phone: ${senderPhone || 'unknown'}`,
      `SMS body: """${messageBody}"""`,
    ].join('\n');

    const aiResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, TIMEOUTS.ANTHROPIC);
    if (!aiResp.ok) throw new Error('Anthropic API HTTP ' + aiResp.status);
    const data = await aiResp.json();
    const text = data?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned empty response');

    // Same brace-tracking JSON extractor as the other classifiers
    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON in AI response');
    let depth = 0, inString = false, escape = false, jsonStr = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) { if (ch === '\\') { escape = true; continue; } if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonStr = text.slice(start, i + 1); break; } }
    }
    if (!jsonStr) throw new Error('Unbalanced JSON in AI response');
    return JSON.parse(jsonStr);
  }

  /**
   * SMS-specific quote extractor. Tide Phase 7 (2026-05-07).
   *
   * Called when an OUTBOUND SMS from HNC to a known lead contains a $
   * (cheap pre-filter — caller checks first to avoid AI calls on every
   * "thanks!" reply). The AI confirms whether this is a real committed
   * quote vs. a soft reference to pricing.
   *
   * Different from extractQuoteFromTranscript:
   *   - Single message context, no dialogue
   *   - Lower max_tokens (smaller input, smaller output)
   *   - Stricter on what counts as a real quote (SMS quotes are
   *     usually shorter and more committal than verbal ones)
   *
   * Returns: {quote_discussed: bool, amount: number|null, confidence: 'high'|'medium'|'low', reasoning: string}
   */
  async function extractQuoteFromSms({ messageBody, leadName }) {
    const prompt = [
      'You are reviewing a single outbound SMS from Hawaii Natural Clean (a residential and commercial cleaning business) to a lead. Your only job is to detect whether this SMS gave the lead a SPECIFIC committed dollar quote they can act on.',
      '',
      'Return quote_discussed=true ONLY if the SMS proposes a specific committed price, e.g.:',
      '  - "Quote for the move-out clean: $450"',
      '  - "We can do that for $245 total"',
      '  - "The deep clean would be $380"',
      '',
      'Return quote_discussed=false if:',
      '  - No price is mentioned',
      '  - Only a hourly rate without total ("$65/hr - depends on scope")',
      '  - A range was given without commitment ("anywhere from $300-500")',
      '  - The SMS asks the lead about price rather than offering one',
      '  - The dollar amount is for something other than a quote (deposit, late fee, etc.)',
      '',
      'Confidence:',
      '  - "high": SMS clearly states a single dollar figure as THE total price for a service',
      '  - "medium": price is given but with some hedging - still actionable',
      '  - "low": ambiguous, probably worth a manual review',
      '',
      'Amount: extract as a JSON number (no $ sign, no commas). Null if quote_discussed=false.',
      '',
      'Return ONLY a JSON object - first character must be { and last must be }. No preamble, no markdown.',
      'Format: {"quote_discussed": <bool>, "amount": <number|null>, "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}',
      '',
      `Lead name: ${leadName || 'unknown'}`,
      `SMS body: """${messageBody}"""`,
    ].join('\n');

    const aiResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, TIMEOUTS.ANTHROPIC);
    if (!aiResp.ok) throw new Error('Anthropic API HTTP ' + aiResp.status);
    const data = await aiResp.json();
    const text = data?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned empty response');

    // Same brace-tracking JSON extractor as extractQuoteFromTranscript
    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON in AI response');
    let depth = 0, inString = false, escape = false, jsonStr = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) { if (ch === '\\') { escape = true; continue; } if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonStr = text.slice(start, i + 1); break; } }
    }
    if (!jsonStr) throw new Error('Unbalanced JSON in AI response');
    return JSON.parse(jsonStr);
  }

  try {
    const event = req.body;
    const type = event.type;
    const data = event.data?.object;
    const eventId = event.id; // OpenPhone event ID for idempotency

    console.log('OpenPhone webhook received:', type, 'Event ID:', eventId);

    // IDEMPOTENCY CHECK: Skip if this webhook was already processed
    if (eventId) {
      try {
        const alreadyProcessed = await isWebhookProcessed(eventId, 'openphone', SUPABASE_KEY);
        if (alreadyProcessed) {
          console.log('[openphone-webhook] Webhook already processed:', eventId);
          return res.status(200).json({ received: true, type, alreadyProcessed: true });
        }
      } catch (idempotencyErr) {
        console.error('[openphone-webhook] Idempotency check failed:', idempotencyErr.message);
        // If idempotency check fails, fail the webhook to be safe
        return res.status(500).json({ error: 'Idempotency check failed' });
      }
    }

    if (type === 'message.received' && data) {
      const from = data.from;
      const body = data.body || '';
      const client = await findClientByPhone(from);
      const lead = await findLeadByPhone(from);

      await supabaseInsert('messages', {
        thread_id: data.conversationId || from,
        contact_name: client ? client.name : from,
        contact_phone: from,
        contact_type: client ? 'client' : 'unknown',
        direction: 'inbound',
        body: body,
        channel: 'sms',
        read: false,
        quo_message_id: data.id || null
      });

      // If this is a lead response, track it
      if (lead) {
        const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${lead.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            response_count: (lead.response_count || 0) + 1,
            last_responded_at: new Date().toISOString()
          })
        });
        console.log('Lead response tracked:', lead.id, updateRes.status);

        // ── AI classification: does this reply suggest the lead is lost? ──
        // If Haiku returns 'lost' with reasonable confidence, create a VA
        // task for Dane to review. We do NOT auto-flip the stage — the
        // boundary between 'lost' and 'cold/deferred' is fuzzy and
        // false positives would silently lose customers.
        //
        // CLIENT-MATCH GUARD (added 2026-05-08): when a lead converts to a
        // client (stage='Closed won' + client row created), the original
        // lead row stays in the DB for history. findLeadByPhone returns
        // it on every subsequent SMS — so a routine text from an active
        // customer (e.g. Justin Cornair confirming today's booking) was
        // being classified as a lead-response and creating false-positive
        // 'high intent' tasks. Fix: if the sender is ALSO matched as a
        // client, skip lead classification entirely. The response_count
        // bump above is harmless metadata so we leave it. Only the AI
        // classifier and task creation are gated.
        if (client) {
          console.log('[openphone-webhook] sender matched as client (' + client.name + '), skipping lead-response classifier despite lead match');
        } else if (body && body.trim() && process.env.ANTHROPIC_API_KEY) {
          try {
            const verdict = await classifyLeadResponse(body, lead.name);
            console.log('[openphone-webhook] AI verdict for lead', lead.id, ':', JSON.stringify(verdict));
            // Tide Phase 7.2 (2026-05-07): broadened from lost-only to all
            // actionable intents. lost / engaged / deferred each create a
            // review_lead_response task with intent stored in extracted_data
            // so the UI can render intent-appropriate buttons. unclear
            // intent (and any low-confidence verdict) is still ignored.
            const intent = verdict && verdict.intent;
            const isActionable = intent === 'lost' || intent === 'engaged' || intent === 'deferred';
            if (verdict && isActionable && verdict.confidence !== 'low') {
              const leadFirstName = (lead.name || 'Lead').split(' ')[0];
              const today = new Date().toISOString().split('T')[0];
              const truncatedReply = body.length > 200 ? body.slice(0, 197) + '...' : body;

              // Idempotency: skip if there's already an open
              // review_lead_response task for this lead. The classifier
              // can fire on multiple replies from the same lead in a
              // short window; one task is enough for Dane to see the
              // signal.
              const existingTaskResp = await fetch(
                `${SUPABASE_URL}/rest/v1/tasks?related_lead_id=eq.${lead.id}&type=eq.review_lead_response&status=eq.open&select=id&limit=1`,
                { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
              );
              const existingTaskRows = await existingTaskResp.json().catch(() => []);
              if (Array.isArray(existingTaskRows) && existingTaskRows.length > 0) {
                console.log('[openphone-webhook] open review_lead_response task already exists for lead', lead.id, '- skipping');
              } else {
                // Per-intent task title and description framing
                let taskTitle, taskDescription;
                if (intent === 'lost') {
                  taskTitle = `${leadFirstName} responded — mark as lost?`;
                  taskDescription = `Reply: "${truncatedReply}"\n\nAI read: ${verdict.reasoning || 'lead appears lost'} (confidence: ${verdict.confidence})`;
                } else if (intent === 'engaged') {
                  taskTitle = `${leadFirstName} is engaged — review reply`;
                  taskDescription = `Reply: "${truncatedReply}"\n\nAI read: ${verdict.reasoning || 'lead is positively engaging'} (confidence: ${verdict.confidence})\n\nOpen the lead profile to take next action — send quote, schedule, or move stage as appropriate.`;
                } else { // deferred
                  taskTitle = `${leadFirstName} wants to defer — review reply`;
                  taskDescription = `Reply: "${truncatedReply}"\n\nAI read: ${verdict.reasoning || 'lead wants to defer'} (confidence: ${verdict.confidence})\n\nOpen the lead profile to set a wake-up date or move them to Long-Term Follow-Up.`;
                }

                const taskInsertRes = await supabaseInsert('tasks', {
                  title: taskTitle,
                  type: 'review_lead_response',
                  priority: verdict.confidence === 'high' ? 'high' : 'medium',
                  due_date: today,
                  description: taskDescription,
                  related_lead_id: lead.id,
                  status: 'open',
                  extracted_data: {
                    intent: intent,
                    confidence: verdict.confidence,
                    reasoning: verdict.reasoning || null,
                    reply_excerpt: truncatedReply,
                    sms_message_id: data.id || null,
                    current_stage: lead.stage || null,
                  },
                });
                if (!taskInsertRes.ok) {
                  // supabaseInsert is fetch-based and won't throw on 4xx — read the
                  // body so the failure is visible in logs. Previously this fell
                  // through silently when CHECK constraints rejected the type.
                  const errBody = await taskInsertRes.text().catch(() => '<unreadable>');
                  console.error('[openphone-webhook] Task insert FAILED status=' + taskInsertRes.status + ' body=' + errBody.slice(0, 500));
                } else {
                  console.log('[openphone-webhook] Created review_lead_response task (intent=' + intent + ') for', lead.id);

                  // Push fan-out — same pattern as before, intent-aware copy
                  try {
                    const { sendPushToAllSubscribed } = await import('./utils/send-push.js');
                    let pushTitle, pushBody;
                    if (intent === 'lost') {
                      pushTitle = `${leadFirstName} replied — mark as lost?`;
                      pushBody = `AI flagged this as likely lost (${verdict.confidence} confidence). "${truncatedReply.slice(0, 80)}${truncatedReply.length > 80 ? '...' : ''}"`;
                    } else if (intent === 'engaged') {
                      pushTitle = `${leadFirstName} is engaged`;
                      pushBody = `AI read positive intent (${verdict.confidence}). "${truncatedReply.slice(0, 80)}${truncatedReply.length > 80 ? '...' : ''}"`;
                    } else {
                      pushTitle = `${leadFirstName} wants to defer`;
                      pushBody = `AI read deferral intent (${verdict.confidence}). "${truncatedReply.slice(0, 80)}${truncatedReply.length > 80 ? '...' : ''}"`;
                    }
                    const pushRes = await sendPushToAllSubscribed({
                      title: pushTitle,
                      body: pushBody,
                      url: '/#tasks',
                      tag: 'review-' + lead.id,
                      requireInteraction: verdict.confidence === 'high' && intent === 'lost', // Only lost is urgent enough to require interaction
                    });
                    console.log('[openphone-webhook] Push fanout:', JSON.stringify(pushRes));
                  } catch (pushErr) {
                    console.warn('[openphone-webhook] Push notification failed:', pushErr.message);
                  }
                }
              }
            }
          } catch (aiErr) {
            // Never fail the webhook on AI errors — classification is bonus
            console.warn('[openphone-webhook] AI classification failed:', aiErr.message);
          }
        }
      }

      // ── Unknown-sender SMS lead detection (Tide Phase 7) ──────────────────
      // If the SMS came from a number that's neither a lead nor a client,
      // classify whether it's a real cleaning inquiry. Same pattern as the
      // call-based review_call_lead flow but with a smaller AI prompt.
      // Reuses the review_call_lead task type so the existing UI buttons
      // ("Review & create" / "Not a lead") and accept-call-lead.js endpoint
      // work identically.
      //
      // Skip cases (cheap pre-filters BEFORE the AI call):
      //   - Sender is already a known lead (handled by lost-intent above)
      //   - Sender is an existing client (clients aren't leads)
      //   - Body is too short (<20 chars - "hi" / "thanks" / single emoji)
      //   - Open review_call_lead task already exists for this phone
      //     (idempotency across multiple SMSes from the same unknown sender)
      if (!lead && !client && body && body.trim().length >= 20 && process.env.ANTHROPIC_API_KEY) {
        try {
          // Idempotency: skip if there's already an open review_call_lead
          // task with this phone in extracted_data. Postgrest JSONB filter
          // is exact-match on the inner string field.
          const existingTaskResp = await fetch(
            `${SUPABASE_URL}/rest/v1/tasks?type=eq.review_call_lead&status=eq.open&extracted_data->>phone=eq.${encodeURIComponent(from)}&select=id&limit=1`,
            { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
          );
          const existingTaskRows = await existingTaskResp.json().catch(() => []);
          if (Array.isArray(existingTaskRows) && existingTaskRows.length > 0) {
            console.log('[openphone-webhook] open review_call_lead task already exists for phone', from, '- skipping SMS lead-classify');
          } else {
            const verdict = await classifyAndExtractSmsLead({
              messageBody: body,
              senderPhone: from,
            });
            console.log('[openphone-webhook] SMS lead-classify verdict for', from, ':', JSON.stringify(verdict).slice(0, 400));

            if (verdict && verdict.is_lead === true && verdict.confidence !== 'low') {
              const extracted = verdict.extracted || {};
              const senderName = extracted.name || ('SMS from ' + from);
              const today = new Date().toISOString().split('T')[0];
              const truncatedBody = body.length > 300 ? body.slice(0, 297) + '...' : body;

              const taskInsertRes = await supabaseInsert('tasks', {
                title: 'New SMS lead - ' + senderName,
                type: 'review_call_lead',
                priority: verdict.confidence === 'high' ? 'high' : 'medium',
                due_date: today,
                description:
                  'Inbound SMS from ' + from + '\n\n' +
                  'AI read: ' + (verdict.reasoning || 'looks like a lead inquiry') + ' (confidence: ' + verdict.confidence + ')\n\n' +
                  'Message: "' + truncatedBody + '"',
                status: 'open',
                extracted_data: {
                  name: extracted.name || null,
                  phone: from || null,
                  service: extracted.service || null,
                  address: extracted.address || null,
                  beds: extracted.beds || null,
                  baths: extracted.baths || null,
                  sqft: extracted.sqft || null,
                  condition: null, // SMS rarely mentions property condition
                  frequency: extracted.frequency || null,
                  notes: extracted.notes || '',
                  // No quote info from SMS lead detection - SMS lead messages
                  // are inquiries, not quotes. accept-call-lead.js will skip
                  // the quote-chain step when these fields are null/none.
                  quote_amount: null,
                  quote_confidence: 'none',
                  sms_message_id: data.id || null,
                  ai_confidence: verdict.confidence,
                  ai_reasoning: verdict.reasoning || null,
                  source: 'SMS',
                },
              });

              if (!taskInsertRes.ok) {
                const errBody = await taskInsertRes.text().catch(() => '<unreadable>');
                console.error('[openphone-webhook] SMS review_call_lead insert FAILED status=' + taskInsertRes.status + ' body=' + errBody.slice(0, 500));
                await logError('openphone-webhook:sms-review_call_lead', new Error('Task insert ' + taskInsertRes.status), {
                  phone: from, body: errBody.slice(0, 500),
                });
              } else {
                console.log('[openphone-webhook] Created review_call_lead task (SMS-source) for phone', from);
                // Push fan-out — same pattern as call-source lead detection
                try {
                  const { sendPushToAllSubscribed } = await import('./utils/send-push.js');
                  const pushRes = await sendPushToAllSubscribed({
                    title: 'New SMS lead - ' + senderName,
                    body: 'AI read: ' + (verdict.reasoning || 'looks like a lead').slice(0, 100),
                    url: '/#tasks',
                    tag: 'sms-lead-' + (data.id || from),
                    requireInteraction: verdict.confidence === 'high',
                  });
                  console.log('[openphone-webhook] SMS lead push fanout:', JSON.stringify(pushRes));
                } catch (pushErr) {
                  console.warn('[openphone-webhook] SMS lead push failed:', pushErr.message);
                }
              }
            }
          }
        } catch (smsLeadErr) {
          console.warn('[openphone-webhook] SMS lead classification failed:', smsLeadErr.message);
          await logError('openphone-webhook:sms-lead-classify', smsLeadErr, {
            phone: from,
            body_length: body ? body.length : 0,
          });
        }
      }
    }

    // ── Outbound SMS: detect quote-mentioning messages ──────────────────────
    // Tide Phase 7 (2026-05-07). When HNC sends an SMS to a known lead and
    // the body contains a $, classify whether it's a real committed quote.
    // If yes, create a review_quote_sent task so Dane can confirm and stamp
    // the lead's quote_sent_at + quote_total in one tap. Same task type and
    // UI buttons as the call-based path.
    //
    // Skip cases (cheap pre-filters BEFORE the AI call):
    //   - Message body has no $ at all (most outbound texts)
    //   - Recipient isn't a lead in our system (clients, prospects, etc.)
    //   - Lead already has an open review_quote_sent task (idempotency)
    //
    // Why message.delivered and not message.sent? Delivered is the more
    // reliable lifecycle event — fires only after the carrier ack'd it.
    // Sent fires earlier and can trigger on messages that ultimately fail.
    if ((type === 'message.delivered' || type === 'message.sent') && data) {
      const to = data.to;
      const body = data.body || data.text || '';
      const direction = data.direction || 'outbound';

      // Defensive: only handle outbound (HNC → lead). The webhook docs say
      // delivered/sent are outbound-only but we double-check the field.
      if (direction !== 'outbound') {
        console.log('[openphone-webhook]', type, 'with non-outbound direction', direction, '- skipping');
      } else {
        // Cheap pre-filter: skip without AI call if no $ in body. Saves
        // ~95% of outbound texts (most don't contain prices).
        if (!body || !body.includes('$')) {
          // Not a quote candidate — nothing to do
        } else {
          try {
            const recipientPhone = Array.isArray(to) ? to[0] : to;
            const lead = recipientPhone ? await findLeadByPhone(recipientPhone) : null;
            const client = recipientPhone ? await findClientByPhone(recipientPhone) : null;

            if (client) {
              console.log('[openphone-webhook]', type, 'to existing client - skipping quote-detect (clients are not quoted, they are paying customers)');
            } else if (!lead) {
              console.log('[openphone-webhook]', type, 'to unknown number - skipping quote-detect (no lead to attach task to)');
            } else if (!process.env.ANTHROPIC_API_KEY) {
              console.warn('[openphone-webhook] ANTHROPIC_API_KEY not set - skipping SMS quote-detect');
            } else {
              // Idempotency check first — don't burn an AI call if there's
              // already an open task for this lead.
              const existingTaskResp = await fetch(
                `${SUPABASE_URL}/rest/v1/tasks?related_lead_id=eq.${lead.id}&type=eq.review_quote_sent&status=eq.open&select=id&limit=1`,
                { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
              );
              const existingTaskRows = await existingTaskResp.json().catch(() => []);
              if (Array.isArray(existingTaskRows) && existingTaskRows.length > 0) {
                console.log('[openphone-webhook] open review_quote_sent task already exists for lead', lead.id, '- skipping SMS quote-detect');
              } else {
                const qVerdict = await extractQuoteFromSms({
                  messageBody: body,
                  leadName: lead.name || '',
                });
                console.log('[openphone-webhook] SMS quote-detect verdict for lead', lead.id, ':', JSON.stringify(qVerdict).slice(0, 300));

                if (qVerdict && qVerdict.quote_discussed === true && qVerdict.confidence !== 'low' && typeof qVerdict.amount === 'number' && qVerdict.amount > 0) {
                  const today = new Date().toISOString().split('T')[0];
                  const amount = Number(qVerdict.amount);
                  const truncatedBody = body.length > 200 ? body.slice(0, 197) + '...' : body;
                  const taskRes = await supabaseInsert('tasks', {
                    title: `Confirm $${amount.toFixed(2)} quote for ${lead.name || 'lead'}`,
                    type: 'review_quote_sent',
                    priority: qVerdict.confidence === 'high' ? 'high' : 'medium',
                    due_date: today,
                    description:
                      `Detected on outbound SMS to ${lead.name || 'lead'}.\n\n` +
                      `Message: "${truncatedBody}"\n\n` +
                      `AI read: ${qVerdict.reasoning || 'price was quoted in SMS'} (confidence: ${qVerdict.confidence})\n\n` +
                      `Confirm the amount to stamp quote_sent_at on this lead - that's what kicks off the Tide Quoted cadence.`,
                    status: 'open',
                    related_lead_id: lead.id,
                    extracted_data: {
                      amount: amount,
                      confidence: qVerdict.confidence,
                      reasoning: qVerdict.reasoning || null,
                      sms_message_id: data.id || null,
                      source: 'sms',
                    },
                  });
                  if (!taskRes.ok) {
                    const errBody = await taskRes.text().catch(() => '<unreadable>');
                    console.error('[openphone-webhook] SMS review_quote_sent insert FAILED status=' + taskRes.status + ' body=' + errBody.slice(0, 500));
                    await logError('openphone-webhook:sms-review_quote_sent', new Error('Task insert ' + taskRes.status), {
                      lead_id: lead.id, body: errBody.slice(0, 500),
                    });
                  } else {
                    console.log('[openphone-webhook] Created review_quote_sent task (SMS-source) for lead', lead.id, 'amount=$' + amount.toFixed(2));
                    // Push fan-out — same pattern as call-source quote tasks.
                    try {
                      const { sendPushToAllSubscribed } = await import('./utils/send-push.js');
                      const pushRes = await sendPushToAllSubscribed({
                        title: `Confirm $${amount.toFixed(2)} quote - ${lead.name || 'lead'}`,
                        body: `AI read SMS: ${(qVerdict.reasoning || 'price was quoted').slice(0, 100)}`,
                        url: '/#tasks',
                        tag: 'quote-sms-' + (data.id || lead.id),
                        requireInteraction: qVerdict.confidence === 'high',
                      });
                      console.log('[openphone-webhook] SMS quote-confirm push fanout:', JSON.stringify(pushRes));
                    } catch (pushErr) {
                      console.warn('[openphone-webhook] SMS quote-confirm push failed:', pushErr.message);
                    }
                  }
                }
              }
            }
          } catch (smsQuoteErr) {
            // Never fail the webhook on quote-detect errors
            console.warn('[openphone-webhook] SMS quote-detect failed:', smsQuoteErr.message);
            await logError('openphone-webhook:sms-quote-detect', smsQuoteErr, {
              event_type: type,
              has_data: !!data,
            });
          }
        }
      }
    }

    if (type === 'call.completed' && data) {
      // ── BUG FIX 2026-05-08: OpenPhone uses 'incoming'/'outgoing' but our ─
      // ── code expected 'inbound'/'outbound'. The mismatch caused: ────────
      //   1. phone field stored YOUR number (data.to) instead of caller's
      //      because `direction === 'inbound'` was always false
      //   2. The classifier gate at line ~993 rejected every call because
      //      callRow.direction !== 'inbound' was true for every real call
      //   3. Lead detection has been silently broken for inbound calls
      //      since this feature shipped
      // Normalize to the 'inbound'/'outbound' canonical form before any
      // logic runs. Accept either spelling defensively in case OpenPhone
      // changes it again.
      const rawDirection = String(data.direction || '').toLowerCase();
      const direction = (rawDirection === 'incoming' || rawDirection === 'inbound') ? 'inbound'
        : (rawDirection === 'outgoing' || rawDirection === 'outbound') ? 'outbound'
        : rawDirection;
      const phone = direction === 'inbound' ? data.from : data.to;
      // OpenPhone's duration field name varies across event payloads. Check
      // common variants — data.duration, data.duration_seconds, data.callDuration
      // — so the 30s gate works regardless of which one this event uses.
      const duration = data.duration || data.duration_seconds || data.callDuration || null;
      const client = await findClientByPhone(phone);

      console.log('[openphone-webhook] call.completed callId=' + data.id + ' rawDirection=' + rawDirection + ' normalized=' + direction + ' phone=' + phone + ' duration=' + duration);

      await supabaseUpsert('call_transcripts', {
        call_id: data.id,
        phone: phone,
        direction: direction,
        duration_seconds: duration,
        called_at: data.createdAt || new Date().toISOString(),
        status: 'completed',
        client_id: client ? client.id : null,
        client_name: client ? client.name : ('Unknown — ' + phone)
      }, 'call_id');
    }

    if (type === 'call.summary.completed' && data) {
      const summary = Array.isArray(data.summary)
        ? data.summary.join(' ')
        : (data.summary || '');

      await supabaseUpsert('call_transcripts', {
        call_id: data.callId,
        summary: summary,
        status: 'summary_ready'
      }, 'call_id');
    }

    if (type === 'call.transcript.completed' && data) {
      const dialogue = data.dialogue || [];
      const transcript = dialogue.map(l => (l.identifier || 'Unknown') + ': ' + l.content).join('\n');

      await supabaseUpsert('call_transcripts', {
        call_id: data.callId,
        transcript: transcript,
        status: 'transcript_ready'
      }, 'call_id');

      // ── Auto-log inbound call leads ─────────────────────────────────────
      // Read back the call_transcripts row (call.completed should have written
      // direction/duration/phone earlier). If this is an inbound call from an
      // unknown number with a transcript, classify it and — if it looks like
      // a real lead — create a `review_call_lead` task with an AI-extracted
      // draft so Dane can one-tap accept.
      try {
        const callRowResp = await fetch(
          `${SUPABASE_URL}/rest/v1/call_transcripts?call_id=eq.${encodeURIComponent(data.callId)}&select=phone,direction,duration_seconds,summary,client_id&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const callRows = await callRowResp.json();
        const callRow = Array.isArray(callRows) && callRows[0];

        if (!callRow) {
          console.log('[openphone-webhook] call.transcript.completed: no call_transcripts row yet for', data.callId, '— skipping lead-classify');
        } else if (callRow.direction !== 'inbound') {
          console.log('[openphone-webhook] call', data.callId, 'is', callRow.direction, '— skipping lead-classify');
        } else if (callRow.duration_seconds !== null && callRow.duration_seconds !== undefined && callRow.duration_seconds < 30) {
          // Only reject when duration is explicitly known AND below 30s.
          // Null duration means OpenPhone didn't send it — fall through to
          // transcript-length check which is a more reliable signal anyway.
          console.log('[openphone-webhook] call', data.callId, 'too short (' + callRow.duration_seconds + 's) — skipping lead-classify');
        } else if (!transcript || transcript.length < 40) {
          console.log('[openphone-webhook] call', data.callId, 'transcript too short — skipping lead-classify');
        } else if (callRow.client_id) {
          console.log('[openphone-webhook] call', data.callId, 'is from existing client — skipping lead-classify');
        } else {
          // Final unknown-number check (clients table may have changed since
          // call.completed wrote client_id; also catches existing leads).
          const callerPhone = callRow.phone;
          const existingClient = await findClientByPhone(callerPhone);
          const existingLead = await findLeadByPhone(callerPhone);
          if (existingClient || existingLead) {
            // Existing-client calls are skipped entirely (clients aren't quoted —
            // they're already paying customers). Existing-lead calls run quote
            // detection: if the rep verbally quoted a price, drop a
            // review_quote_sent task so Dane can confirm and stamp the lead.
            if (existingClient) {
              console.log('[openphone-webhook] call', data.callId, 'is from existing client — skipping lead-classify and quote-detect');
            } else if (!process.env.ANTHROPIC_API_KEY) {
              console.warn('[openphone-webhook] ANTHROPIC_API_KEY not set — skipping quote-detect');
            } else {
              try {
                const qVerdict = await extractQuoteFromTranscript({
                  transcript,
                  summary: callRow.summary || '',
                  leadName: existingLead.name || '',
                  durationSeconds: callRow.duration_seconds,
                });
                console.log('[openphone-webhook] quote-detect verdict for', data.callId, ':', JSON.stringify(qVerdict).slice(0, 300));

                if (qVerdict && qVerdict.quote_discussed === true && qVerdict.confidence !== 'low' && typeof qVerdict.amount === 'number' && qVerdict.amount > 0) {
                  // Idempotency: skip if an open review_quote_sent task already
                  // exists for this lead (e.g. duplicate webhook delivery, or
                  // the lead just had a separate call earlier today). The
                  // confirm endpoint will close the existing one.
                  const existingTaskResp = await fetch(
                    `${SUPABASE_URL}/rest/v1/tasks?related_lead_id=eq.${existingLead.id}&type=eq.review_quote_sent&status=eq.open&select=id&limit=1`,
                    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
                  );
                  const existingTaskRows = await existingTaskResp.json().catch(() => []);
                  if (Array.isArray(existingTaskRows) && existingTaskRows.length > 0) {
                    console.log('[openphone-webhook] open review_quote_sent task already exists for lead', existingLead.id, '— skipping');
                  } else {
                    const today = new Date().toISOString().split('T')[0];
                    const amount = Number(qVerdict.amount);
                    const taskRes = await supabaseInsert('tasks', {
                      title: `Confirm $${amount.toFixed(2)} quote for ${existingLead.name || 'lead'}`,
                      type: 'review_quote_sent',
                      priority: qVerdict.confidence === 'high' ? 'high' : 'medium',
                      due_date: today,
                      description:
                        `Detected on call ${data.callId} (${callRow.duration_seconds || '?'}s).\n\n` +
                        `AI read: ${qVerdict.reasoning || 'price was quoted on the call'} (confidence: ${qVerdict.confidence})\n\n` +
                        `Confirm the amount to stamp quote_sent_at on this lead — that's what kicks off the Day-1 followup task.`,
                      status: 'open',
                      related_lead_id: existingLead.id,
                      extracted_data: {
                        amount: amount,
                        confidence: qVerdict.confidence,
                        reasoning: qVerdict.reasoning || null,
                        call_id: data.callId,
                      },
                    });
                    if (!taskRes.ok) {
                      const errBody = await taskRes.text().catch(() => '<unreadable>');
                      console.error('[openphone-webhook] review_quote_sent insert FAILED status=' + taskRes.status + ' body=' + errBody.slice(0, 500));
                      await logError('openphone-webhook:review_quote_sent', new Error('Task insert ' + taskRes.status), {
                        call_id: data.callId, lead_id: existingLead.id, body: errBody.slice(0, 500),
                      });
                    } else {
                      console.log('[openphone-webhook] Created review_quote_sent task for lead', existingLead.id, 'amount=$' + amount.toFixed(2));
                      // Push fan-out — same pattern as review_call_lead.
                      try {
                        const { sendPushToAllSubscribed } = await import('./utils/send-push.js');
                        const pushRes = await sendPushToAllSubscribed({
                          title: `Confirm $${amount.toFixed(2)} quote — ${existingLead.name || 'lead'}`,
                          body: `AI read: ${(qVerdict.reasoning || 'price was quoted').slice(0, 100)}`,
                          url: '/#tasks',
                          tag: 'quote-' + data.callId,
                          requireInteraction: qVerdict.confidence === 'high',
                        });
                        console.log('[openphone-webhook] quote-confirm push fanout:', JSON.stringify(pushRes));
                      } catch (pushErr) {
                        console.warn('[openphone-webhook] quote-confirm push failed:', pushErr.message);
                      }
                    }
                  }
                }
              } catch (qErr) {
                console.error('[openphone-webhook] quote-detect failed for', data.callId, ':', qErr.message);
                await logError('openphone-webhook:quote-detect', qErr, { call_id: data.callId, lead_id: existingLead.id });
              }
            }
          } else if (!process.env.ANTHROPIC_API_KEY) {
            console.warn('[openphone-webhook] ANTHROPIC_API_KEY not set — skipping lead-classify');
          } else {
            const verdict = await classifyAndExtractCallLead({
              transcript,
              summary: callRow.summary || '',
              callerPhone,
              durationSeconds: callRow.duration_seconds,
            });
            console.log('[openphone-webhook] call-lead verdict for', data.callId, ':', JSON.stringify(verdict).slice(0, 400));

            // Only act on is_lead=true with non-low confidence. Low confidence
            // = coin flip; we prefer to silently miss those rather than spam
            // Dane with junk-call review tasks.
            if (verdict && verdict.is_lead === true && verdict.confidence !== 'low') {
              const extracted = verdict.extracted || {};
              const callerName = extracted.name || ('Caller ' + (callerPhone || 'unknown'));
              const today = new Date().toISOString().split('T')[0];
              const summaryExcerpt = (callRow.summary || transcript || '').slice(0, 300);

              const taskInsertRes = await supabaseInsert('tasks', {
                title: 'New call lead — ' + callerName,
                type: 'review_call_lead',
                priority: verdict.confidence === 'high' ? 'high' : 'medium',
                due_date: today,
                description:
                  'Inbound call from ' + (callerPhone || 'unknown') + '\n\n' +
                  'AI read: ' + (verdict.reasoning || 'looks like a lead inquiry') + ' (confidence: ' + verdict.confidence + ')\n\n' +
                  'Excerpt: ' + summaryExcerpt,
                status: 'open',
                extracted_data: {
                  name: extracted.name || null,
                  phone: callerPhone || null,
                  service: extracted.service || null,
                  address: extracted.address || null,
                  beds: extracted.beds || null,
                  baths: extracted.baths || null,
                  sqft: extracted.sqft || null,
                  condition: extracted.condition || null,
                  frequency: extracted.frequency || null,
                  notes: extracted.notes || '',
                  // Quote info captured in the same AI pass — accept-call-lead.js
                  // chains a review_quote_sent task using these fields after the
                  // lead is created. Treat 'low' / 'none' confidence as null so
                  // we never spam Dane with iffy auto-quote tasks.
                  quote_amount: (typeof extracted.quote_amount === 'number' && extracted.quote_amount > 0 && (extracted.quote_confidence === 'high' || extracted.quote_confidence === 'medium')) ? extracted.quote_amount : null,
                  quote_confidence: extracted.quote_confidence || 'none',
                  call_id: data.callId,
                  ai_confidence: verdict.confidence,
                  ai_reasoning: verdict.reasoning || null,
                  source: 'Phone call',
                },
              });
              if (!taskInsertRes.ok) {
                const errBody = await taskInsertRes.text().catch(() => '<unreadable>');
                console.error('[openphone-webhook] review_call_lead insert FAILED status=' + taskInsertRes.status + ' body=' + errBody.slice(0, 500));
                await logError('openphone-webhook:review_call_lead', new Error('Task insert ' + taskInsertRes.status), {
                  call_id: data.callId, body: errBody.slice(0, 500)
                });
              } else {
                console.log('[openphone-webhook] Created review_call_lead task for call', data.callId);
                // Push fan-out — same pattern as the SMS lost-intent flow.
                try {
                  const { sendPushToAllSubscribed } = await import('./utils/send-push.js');
                  const pushRes = await sendPushToAllSubscribed({
                    title: 'New call lead — ' + callerName,
                    body: 'AI read: ' + (verdict.reasoning || 'looks like a lead').slice(0, 100),
                    url: '/#tasks',
                    tag: 'call-lead-' + data.callId,
                    requireInteraction: verdict.confidence === 'high',
                  });
                  console.log('[openphone-webhook] call-lead push fanout:', JSON.stringify(pushRes));
                } catch (pushErr) {
                  console.warn('[openphone-webhook] call-lead push failed:', pushErr.message);
                }
              }
            }
          }
        }
      } catch (classifyErr) {
        // Never fail the webhook on classification errors — best-effort feature
        console.warn('[openphone-webhook] call-lead classify failed:', classifyErr.message);
        try {
          await logError('openphone-webhook:classify-call-lead', classifyErr, { call_id: data.callId });
        } catch (_) { /* logging failure must not break the webhook */ }
      }
    }

    // Record the webhook as processed
    if (eventId) {
      try {
        await recordWebhook(eventId, 'openphone', type, event, SUPABASE_KEY);
      } catch (recordErr) {
        console.warn('[openphone-webhook] Failed to record webhook:', recordErr.message);
        // Don't fail the whole webhook if recording fails, but log it
      }
    }

    return res.status(200).json({ received: true, type });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}