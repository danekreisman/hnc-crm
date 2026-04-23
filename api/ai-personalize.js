/**
 * POST /api/ai-personalize
 *
 * Takes a template message and personalizes it using Claude, with context
 * pulled from the client/lead record, recent OpenPhone calls, and SMS history.
 *
 * Body:
 *   template:      string  (required) — the raw template to personalize
 *   channel:       'sms' | 'email'  (required)
 *   clientId:      string  (optional) — if present, pulls client + history
 *   leadId:        string  (optional) — if present, pulls lead + history
 *   phone:         string  (optional) — used to find call/message history
 *   purpose:       string  (optional) — short hint like "3-day follow-up" for tone
 *   bookingUrl:    string  (optional) — personalized booking link for quoted leads
 *   businessPhone: string  (optional) — HNC business phone number for call/text CTA
 *
 * Returns:
 *   { message: string, personalized: boolean, reason?: string }
 *
 * SAFETY: This endpoint NEVER throws a send-blocking error. If Claude fails,
 * if context is missing, or if the response is suspicious, it returns the
 * original template with personalized: false so the caller can still send it.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';
import { getOpenPhoneHistory } from './utils/openphone-history.js';

const SYSTEM_PROMPT = `You are the messaging voice of Hawaii Natural Clean (HNC), a premium residential and commercial cleaning company serving Oahu and Maui.

YOUR JOB: Rewrite the given template into a personalized message for a specific client or lead, using only the factual context provided. The message should feel like it came from Dane (the owner) personally.

VOICE RULES — FOLLOW STRICTLY:
- Use "Aloha" instead of Hi, Hey, or Hello.
- Use "Mahalo" instead of Thanks, Thank you, or Goodbye.
- Warm, natural, professional. Never salesy. Never corporate.
- Avoid: "delighted to", "reach out", "touch base", "circle back", "synergy", "valued customer".
- Emojis: 🌺 can appear at most ONCE per message, and only if the template already uses it or the tone calls for it. Never force it.
- Do NOT invent facts. Only reference what's in the provided context.
- Do NOT reference sensitive topics from transcripts: medical issues, family problems, financial stress, relationship issues, personal tragedy. ONLY use logistics: pets, schedule preferences, property details, service preferences, previous requests.
- Keep the original message's core intent intact. (The booking call-to-action may be rewritten per the BOOKING CHANNELS rules below.)

BOOKING CHANNELS — FOLLOW STRICTLY, OVERRIDES TEMPLATE WORDING:
HNC has exactly three ways a lead can book. Never mention a generic "website", "our site", "online portal", or "booking platform" — only use the channels explicitly listed in context.

- If context includes BOTH a "Booking link" and a "Business phone": present all three options — call, text, or tap the booking link. Include the phone number and the link verbatim.
- If context includes ONLY a "Business phone" (no booking link): offer only call or text. Do NOT mention any link, form, booking page, or website.
- If context includes NEITHER: do not mention booking channels at all. Keep the template's intent without inventing a booking pitch.

If the template says "book on our website", "book online", or anything similar, REPLACE that wording with the correct channel(s) per the rules above. This is the one case where overriding the template's exact call-to-action is required.

LENGTH RULES:
- For SMS: MUST stay under 320 characters. Shorter is better.
- For email body: 2–4 short paragraphs max. Concise.

OUTPUT: Return ONLY the rewritten message text. No preamble, no explanation, no quotes around it, no "Here is the message:". Just the message itself, ready to send.`;

// Suspicious patterns that suggest Claude went off the rails
const SUSPICIOUS_PATTERNS = [
  /here is the (rewritten|personalized|message)/i,
  /^(sure|certainly|absolutely|of course),?\s/i,
  /^i('ll| will| have)/i,
  /\bAI\b/,
  /as an assistant/i,
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { template, channel, clientId, leadId, phone, purpose, bookingUrl, businessPhone } = req.body || {};

  // Basic validation — we fall back to template if anything is off, never error
  if (!template || typeof template !== 'string' || template.trim().length === 0) {
    return res.status(400).json({ error: 'template is required' });
  }
  if (!channel || (channel !== 'sms' && channel !== 'email')) {
    return res.status(400).json({ error: 'channel must be "sms" or "email"' });
  }
  if (template.length > 5000) {
    return res.status(400).json({ error: 'template must be under 5000 characters' });
  }

  if (bookingUrl !== undefined && bookingUrl !== null) {
    if (typeof bookingUrl !== 'string' || bookingUrl.length > 500) {
      return res.status(400).json({ error: 'bookingUrl must be a string under 500 characters' });
    }
  }

  if (businessPhone !== undefined && businessPhone !== null) {
    if (typeof businessPhone !== 'string' || businessPhone.length > 30) {
      return res.status(400).json({ error: 'businessPhone must be a string under 30 characters' });
    }
  }

  const fallback = (reason) => res.status(200).json({
    message: template,
    personalized: false,
    reason,
  });

  try {
    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    // ─── Build context from DB ──────────────────────────────────────────────
    let subject = null; // client or lead record
    let contactPhone = phone || null;

    if (clientId) {
      const { data } = await db.from('clients').select('*').eq('id', clientId).maybeSingle();
      if (data) {
        subject = { kind: 'client', ...data };
        contactPhone = contactPhone || data.phone;
      }
    } else if (leadId) {
      const { data } = await db.from('leads').select('*').eq('id', leadId).maybeSingle();
      if (data) {
        subject = { kind: 'lead', ...data };
        contactPhone = contactPhone || data.phone;
      }
    }

    // Full conversation history from OpenPhone API (SMS + call summaries)
    let openPhoneHistory = '';
    if (contactPhone) {
      openPhoneHistory = await getOpenPhoneHistory(contactPhone, {
        apiKey: process.env.QUO_API_KEY,
        maxSms: 200,
        maxCalls: 25,
      });
    }
    // Keep backward-compat vars so the rest of the function still works
    const lastCall = null;
    const recentSms = [];

    // ─── If we have no context at all, just return the template ─────────────
    if (!subject && !lastCall && recentSms.length === 0 && !bookingUrl && !businessPhone) {
      return fallback('no_context_available');
    }

    // ─── Build the context block for Claude ───────────────────────────────────
    const contextLines = [];

    if (subject) {
      const firstName = (subject.name || '').split(' ')[0];
      contextLines.push(`Client name: ${subject.name || 'unknown'} (use "${firstName || 'there'}")`);
      if (subject.service) contextLines.push(`Service: ${subject.service}`);
      if (subject.address) contextLines.push(`Address: ${subject.address}`);
      if (subject.quote_total) contextLines.push(`Quote amount: $${subject.quote_total}`);
      if (subject.segment) contextLines.push(`Segment: ${subject.segment}`);
      if (subject.kind === 'lead' && subject.stage) contextLines.push(`Lead stage: ${subject.stage}`);
    }

    // Full OpenPhone conversation history (SMS + call summaries)
    if (openPhoneHistory) {
      contextLines.push(`Conversation history (SMS + calls):\n${openPhoneHistory}`);
    }

    if (bookingUrl) contextLines.push(`Booking link (use verbatim): ${bookingUrl}`);
    if (businessPhone) contextLines.push(`Business phone (for call/text, use verbatim): ${businessPhone}`);

    const userPrompt = [
      `Channel: ${channel.toUpperCase()}`,
      purpose ? `Purpose: ${purpose}` : null,
      '',
      'Context:',
      contextLines.join('\n'),
      '',
      'Template to personalize:',
      template,
      '',
      'Rewrite the template using the context. Output only the final message.',
    ].filter(Boolean).join('\n');

    // ─── Call Claude ──────────────────────────────────────────────────────────
    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: channel === 'sms' ? 200 : 600,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      },
      TIMEOUTS.ANTHROPIC,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      await logError('ai-personalize', `Anthropic ${response.status}`, {
        status: response.status,
        body: body.slice(0, 500),
        clientId,
        leadId,
      });
      return fallback('ai_service_error');
    }

    const data = await response.json();
    let message = (data.content?.[0]?.text || '').trim();

    if (!message) return fallback('empty_response');

    // Strip accidental quote wrapping
    if (
      (message.startsWith('"') && message.endsWith('"')) ||
      (message.startsWith('\u201C') && message.endsWith('\u201D'))
    ) {
      message = message.slice(1, -1).trim();
    }

    // Suspicious output check — if Claude leaked meta-commentary, fall back
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(message)) {
        await logError('ai-personalize', 'suspicious_output', {
          pattern: pattern.toString(),
          output: message.slice(0, 200),
        });
        return fallback('suspicious_output');
      }
    }

    // Enforce SMS length — if AI ignored the rule, truncate and fall back
    if (channel === 'sms' && message.length > 320) {
      return fallback('sms_too_long');
    }

    return res.status(200).json({
      message,
      personalized: true,
      context_used: {
        has_subject: !!subject,
        has_call: !!lastCall,
        sms_count: recentSms.length,
      },
    });

  } catch (err) {
    await logError('ai-personalize', err, { clientId, leadId, channel });
    return fallback('unexpected_error');
  }
}
