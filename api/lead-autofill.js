// api/lead-autofill.js
//
// Lead profile autofill — pulls all SMS + call history for a lead's phone
// number from OpenPhone, runs AI extraction against the full conversation,
// and returns suggested values for empty lead fields.
//
// Created 2026-05-08 to solve: leads who came in via call/SMS rarely have
// their structured data filled in (beds, baths, sqft, address, etc).
// Dane was manually scrolling through call summaries / SMS threads to find
// the info. This endpoint automates that.
//
// Flow:
//   1. Lookup lead by id (auth-gated)
//   2. Fetch full OpenPhone history for lead.phone via getOpenPhoneHistory
//   3. Send history to Claude Haiku with extraction prompt
//   4. Return suggested fields + which lead fields are currently empty
//      (so the UI can show a preview and only update the empty ones)
//
// The endpoint does NOT modify the lead row directly — that's the client's
// responsibility after the user confirms in the preview UI. Keeps the
// "I clicked the button by accident" failure mode safe.

import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';
import { logError } from './utils/error-logger.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hehfecnjmgsthxjxlvpz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — require a valid session token. Lead profile is admin-only in the
  // UI, so any session reaching this endpoint is implicitly an admin user.
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  // Verify the token via Supabase auth — uses anon key + token, NOT the
  // service-role key (which would bypass auth). If the token is bad, this
  // returns 401 from Supabase.
  const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': process.env.SUPABASE_ANON_KEY || SUPABASE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!verifyRes.ok) return res.status(401).json({ error: 'Invalid token' });

  const { leadId } = req.body || {};
  if (!leadId) return res.status(400).json({ error: 'leadId required' });

  try {
    // 1. Fetch the lead — service role to bypass RLS since we already
    // verified the user above.
    const leadResp = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}&select=*&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!leadResp.ok) {
      return res.status(500).json({ error: 'Lead lookup failed: ' + leadResp.status });
    }
    const leadRows = await leadResp.json();
    const lead = Array.isArray(leadRows) && leadRows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number to look up history' });

    // 2. Fetch full OpenPhone history via shared utility. This already
    //    handles SMS pagination + call summary fetching + formatting.
    const history = await getOpenPhoneHistory(lead.phone, {
      apiKey: process.env.QUO_API_KEY,
      maxSms: 200,
      maxCalls: 25,
    });

    if (!history) {
      return res.status(200).json({
        ok: true,
        suggested: {},
        empty_fields: [],
        message: 'No call or SMS history found for this number.',
      });
    }

    // 3. Run AI extraction against the full history.
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const prompt = [
      'You are extracting structured lead information from a full call and SMS conversation history between Hawaii Natural Clean (HNC, a residential and commercial cleaning company in Hawaii) and a potential customer.',
      '',
      'Read the entire history below carefully. Extract every piece of information the lead has shared at any point - across all calls and messages.',
      '',
      'Extract these fields (set to null when not mentioned anywhere - never invent or guess):',
      '  - name: Lead\'s full name if mentioned',
      '  - service: One of "Move-out Cleaning", "Deep Cleaning", "Regular Cleaning", "Airbnb Turnover", "Janitorial Cleaning", or null. Pick the best match for what they want.',
      '  - address: Full or partial address (street + city if available)',
      '  - beds: Integer (bedrooms)',
      '  - baths: Number (bathrooms - can be 1.5, 2.5, etc.)',
      '  - sqft: Integer (square feet of property)',
      '  - condition: One of "Pristine", "Decent", "Moderately dirty", "Very dirty", "Extreme", or null',
      '  - frequency: One of "weekly", "biweekly", "monthly", "one-time", or null',
      '  - timeline: When they want service (e.g. "next week", "Friday", "ASAP", "flexible", or null)',
      '  - notes: Any other useful context that doesn\'t fit above fields - quirks, special requests, who they are, where they heard about us, pets, accessibility, parking, etc.',
      '',
      'Return ONLY a JSON object - first character must be { and last must be }. No preamble, no markdown.',
      'Format: {"name": <string|null>, "service": <string|null>, "address": <string|null>, "beds": <int|null>, "baths": <number|null>, "sqft": <int|null>, "condition": <string|null>, "frequency": <string|null>, "timeline": <string|null>, "notes": <string|null>}',
      '',
      'Lead phone: ' + lead.phone,
      'Lead name on file: ' + (lead.name || '(none)'),
      '',
      'Conversation history:',
      history,
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
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, TIMEOUTS.ANTHROPIC);

    if (!aiResp.ok) {
      const errBody = await aiResp.text().catch(() => '<unreadable>');
      return res.status(500).json({ error: 'AI extraction failed: ' + aiResp.status, detail: errBody.slice(0, 500) });
    }

    const aiData = await aiResp.json();
    const text = aiData?.content?.[0]?.text || '';
    const start = text.indexOf('{');
    if (start === -1) {
      return res.status(500).json({ error: 'AI returned no JSON', raw: text.slice(0, 300) });
    }
    let depth = 0, inString = false, escape = false, jsonStr = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) { if (ch === '\\') { escape = true; continue; } if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonStr = text.slice(start, i + 1); break; } }
    }
    if (!jsonStr) {
      return res.status(500).json({ error: 'Unbalanced JSON in AI response', raw: text.slice(0, 300) });
    }
    const suggested = JSON.parse(jsonStr);

    // 4. Determine which lead fields are currently empty so the UI can
    //    safely default to "only fill empty fields". The mapping from AI
    //    output keys to lead row column names — most are 1:1 but a few
    //    names differ (sqft → square_feet on some legacy rows; we use
    //    sqft as the canonical name here matching the leads schema).
    const fieldMap = {
      name: 'name',
      service: 'service',
      address: 'address',
      beds: 'beds',
      baths: 'baths',
      sqft: 'sqft',
      condition: 'condition',
      frequency: 'frequency',
      timeline: 'timeline',
      notes: 'notes',
    };
    const empty_fields = [];
    for (const [aiKey, leadCol] of Object.entries(fieldMap)) {
      const current = lead[leadCol];
      const isEmpty = current === null || current === undefined || current === '' ||
                      (typeof current === 'object' && Object.keys(current).length === 0);
      if (isEmpty) empty_fields.push(leadCol);
    }

    return res.status(200).json({
      ok: true,
      suggested,
      empty_fields,
      lead_id: leadId,
      history_chars: history.length,
    });
  } catch (e) {
    console.error('[lead-autofill] error:', e);
    try {
      await logError('lead-autofill', e, { lead_id: leadId });
    } catch (_) {}
    return res.status(500).json({ error: e.message });
  }
}
