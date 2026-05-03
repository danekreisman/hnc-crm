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
          maxSms: 30,
          maxCalls: 5,
        });
      } catch (histErr) {
        console.warn('[lead-followup-generate] OpenPhone history failed:', histErr.message);
      }
    }

    // Build the prompt
    const firstName = (lead.name || lead.contact_name || '').split(' ')[0] || 'there';
    const stage = lead.stage || 'New inquiry';
    const service = lead.service || 'a cleaning';
    const quote = lead.quote_total ? `$${Number(lead.quote_total).toFixed(2)}` : null;
    const daysSinceQuote = lead.quote_sent_at
      ? Math.floor((Date.now() - new Date(lead.quote_sent_at).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const hasReplied = !!lead.last_responded_at;

    const channelInstructions = [];
    if (wantSms) {
      channelInstructions.push(
        [
          'For SMS:',
          '- OPEN with "Aloha [firstName]," — this is the brand voice, not optional. Never "Hey", "Hi", "Hello".',
          '- 1-3 short sentences. Sound like a local Hawaii business owner texting a neighbor, not a sales CRM.',
          '- Sign off "— Dane, Hawaii Natural Clean" or "— Dane 🌺" (pick whichever fits the message length).',
          '- A 🌺 somewhere is welcome but not required. Do NOT stuff multiple emojis.',
          '- Tone reference (do NOT copy literally — match the warmth, not the words):',
          '   "Aloha Sharon! Hope your move is going smooth. Whenever you\'re ready to lock in that move-out clean, just shoot me a text. — Dane 🌺"',
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
          '- Sign off with two lines: "— Dane" then "Hawaii Natural Clean".',
        ].join('\n')
      );
    }

    const stageContext = (() => {
      if (stage === 'New inquiry') return 'They submitted a lead form but have not received a quote yet. Acknowledge their inquiry and confirm you got their request. Aim is to get them to engage so you can follow up with a quote.';
      if (stage === 'Quoted' && !hasReplied && daysSinceQuote && daysSinceQuote >= 1) return `They got a quote ${daysSinceQuote} days ago and have not responded. Friendly nudge to see if they have questions or want to book.`;
      if (stage === 'Quoted' && hasReplied) return 'They got a quote and replied at some point. Look at the conversation history for what they actually said and respond to it. Don\'t pretend you haven\'t talked.';
      if (stage === 'Follow-up') return `Cold lead — got a quote but went silent. Light, no-pressure check-in. Don\'t guilt them. The aim is to leave the door open without being pushy.`;
      if (stage === 'Closed lost') return 'This was marked lost — try to re-engage gently. Maybe they had a reason that\'s no longer true.';
      return 'Generic follow-up. Be friendly and specific.';
    })();

    const prompt = [
      'You are writing a personalized follow-up message from Dane, owner of Hawaii Natural Clean (a cleaning business in Hawaii) to a sales lead.',
      '',
      'CONTEXT:',
      `- Lead: ${lead.name || 'Unknown'}`,
      `- Stage: ${stage}`,
      `- Service interested in: ${service}`,
      lead.address ? `- Address: ${lead.address}` : '',
      quote ? `- Quote sent: ${quote}` : '',
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
      '- Do NOT include a price unless one is provided in CONTEXT — never invent numbers.',
      '- Do NOT mention "the quote" or "your quote" robotically. If you reference price, do it like a person would: "the $179 we talked about" or "the move-out estimate".',
      '',
      'CHECKLIST before you write the message:',
      '  ✓ Does it open with "Aloha"?',
      '  ✓ Does it AVOID every banned phrase?',
      '  ✓ Would it feel natural coming from a small business owner who knows the islands?',
      '  ✓ If you stripped the lead\'s name out, would it still feel like ME wrote it (vs. any cleaning company)?',
      '',
      history && history.trim() ? '\n=== CONVERSATION HISTORY (most recent first) ===\n' + history + '\n=== END HISTORY ===\n' : '',
      'OUTPUT FORMAT:',
      'Return a JSON object with exactly the fields requested below. No markdown code fences, no preamble, just the JSON.',
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

    // Parse JSON, tolerant of code fences and preamble
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace > 0 && lastBrace < cleaned.length - 1) cleaned = cleaned.slice(0, lastBrace + 1);

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      console.error('[lead-followup-generate] JSON parse failed. Raw text:', text);
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
