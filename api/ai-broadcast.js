/**
 * POST /api/ai-broadcast
 *
 * Generates AI-written broadcast email content tailored to HNC's voice.
 * Returns 6 fields that map 1:1 to broadcasts.custom_* columns.
 *
 * Body:
 *   vibe:    string (required)  — one of: holiday | seasonal | reengagement | offer | referral | hawaii_local
 *   offer:   string (optional)  — plain English offer/hook (e.g. "20% off deep cleans this weekend")
 *   audience:string (optional)  — 'leads' | 'clients' | 'both'  (informs tone)
 *   tone:    string (optional)  — 'aloha' | 'direct' | 'hook'   (default 'aloha')
 *
 * Returns JSON:
 *   {
 *     success: true,
 *     subject:        string,
 *     preheader:      string,
 *     heading:        string,
 *     intro:          string,    // includes "Aloha {firstName}!" placeholder
 *     body_html:      string,    // raw HTML for body paragraphs + optional offer box
 *     cta_text:       string,    // button label
 *     cta_url:        string,    // default tel:8084685356
 *   }
 */

import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const SYSTEM_PROMPT = `You are the messaging voice of Hawaii Natural Clean (HNC), a premium residential and commercial cleaning company serving Oahu and Maui.

YOUR JOB: Generate a complete email broadcast given a vibe, an audience, and (optionally) a specific offer. You return exactly 6 fields in JSON: subject, preheader, heading, intro, body_html, cta_text, cta_url.

VOICE RULES — FOLLOW STRICTLY:
- Use "Aloha" instead of Hi, Hey, or Hello.
- Use "Mahalo" instead of Thanks, Thank you, or Goodbye.
- Warm, natural, professional. Never salesy. Never corporate.
- Avoid: "delighted to", "reach out", "touch base", "circle back", "synergy", "valued customer".
- The 🌺 emoji should appear at most ONCE across the entire output. Never force it.
- One emoji in the subject is encouraged (matches the existing template library).
- The body should NEVER contain phone numbers — the CTA button handles contact.
- Keep tone genuine. Hawaii residents can spot fake aloha-language instantly.

FIELD CONSTRAINTS — ABSOLUTE:
- subject: 35-65 characters total. Include exactly one leading emoji related to the vibe.
- preheader: 50-90 characters. The Gmail/Apple Mail preview snippet — should hook the reader.
- heading: 4-9 words. No leading emoji. Trailing emoji is OK if it fits naturally.
- intro: A single paragraph 2-3 sentences. MUST start with "Aloha {firstName}!" (literal placeholder).
- body_html: 2-3 short paragraphs PLUS an optional offer-callout box if the offer is provided. Use the EXACT inline style template shown in the examples below. Do not invent new styles.
- cta_text: 2-5 words. Action-oriented. Examples: "Book a clean", "Reserve my slot", "Get my quote".
- cta_url: default to "tel:8084685356" unless the user has specified a different action.

OFFER PRESERVATION — CRITICAL, NON-NEGOTIABLE:
If the user provides an offer in their message, you MUST preserve EVERY literal detail of that offer EXACTLY:
- Discount percentage: if user says "20% off", output "20% off" — NEVER change to 10%, 15%, or any other number
- Time window: if user says "this weekend", keep "this weekend" — don't substitute "this month", "this week", or anything else
- Service type: if user says "deep cleans", keep "deep cleans" — don't generalize to "cleaning"
- Booking deadline: if user gives a specific date or window, keep that exact date/window
- Dollar amounts: if user says "$50 off", keep "$50 off" — never round, never change

The user's offer text is the source of truth. You may paraphrase the SURROUNDING language for tone, but you may NEVER alter the offer's numbers, dates, percentages, dollar amounts, or service references. Reproduce the offer's specifics verbatim in BOTH the offer-callout box AND any prose that references the offer.

Example — if user offer is "20% off deep cleans this weekend only":
✅ subject: "🌸 20% off deep cleans this weekend only"
✅ offer box headline: "20% Off Deep Cleans"
✅ offer box subtext: "Book this weekend only and save 20% on your deep clean."
❌ NEVER: "10% off", "15% off", "25% off"
❌ NEVER: "this week", "this month", "limited time"
❌ NEVER: "off cleaning" (must say "off deep cleans")

BODY HTML EXAMPLES — match this style exactly:

Plain paragraph:
<p style="margin:0 0 16px;color:#0F172A;font-size:15px;line-height:1.65;">Your text here.</p>

Offer-callout box (use ONLY if an offer is provided):
<div style="background:#EFF9FC;border-radius:12px;padding:20px 24px;margin:0 0 20px;text-align:center;">
  <p style="margin:0 0 6px;color:#0F172A;font-size:18px;font-weight:700;font-family:Georgia,serif;">🌺 Offer headline (3-6 words)</p>
  <p style="margin:0;color:#64748B;font-size:14px;">One-sentence offer description.</p>
</div>

Final paragraph (always end with a soft close like "Mahalo!" or "We'd love to help."):
<p style="margin:0 0 20px;color:#0F172A;font-size:15px;line-height:1.65;">Closing thought. Mahalo!</p>

OUTPUT FORMAT:
Return ONLY valid JSON. No markdown fences, no commentary, no preamble. Exactly:
{"subject":"...", "preheader":"...", "heading":"...", "intro":"Aloha {firstName}! ...", "body_html":"...", "cta_text":"...", "cta_url":"tel:8084685356"}`;

const VIBE_GUIDANCE = {
  holiday: 'A holiday-themed broadcast tied to a specific cultural or seasonal moment. Examples: Easter, 4th of July, Mother\'s Day, Christmas. The body should reference the holiday genuinely and connect it to home/cleaning.',
  seasonal: 'A seasonal moment NOT tied to a specific holiday. Examples: spring refresh, back-to-school transition, end-of-year reset. Connect the season to a cleaning need.',
  reengagement: 'A "we miss you" message to past clients who haven\'t booked recently. Warm, no pressure, low-key invitation to come back.',
  offer: 'A direct promotion centered on the offer provided. The offer-callout box is the centerpiece. Lead with the value, follow with why now is the right time.',
  referral: 'A referral push asking happy clients to refer friends. Mention that both they and the friend benefit. Include a soft call to "share us with a neighbor".',
  hawaii_local: 'Hawaii-specific content tied to local life — storm season prep, tourist season for Airbnb owners, vog/dust from local conditions. Should feel local, not generic.',
};

const TONE_GUIDANCE = {
  aloha: 'Warm, friendly, and unhurried. Lead with connection before utility. Soft close.',
  direct: 'Skip the warm-up. Lead with the value or offer. Still aloha-toned but more efficient.',
  hook: 'Start with a curiosity hook or a specific question. The first sentence should make the reader stop scrolling.',
};

const AUDIENCE_GUIDANCE = {
  leads: 'These recipients have NEVER booked HNC before — they got a quote at some point but haven\'t pulled the trigger. Be welcoming, no inside-baseball references.',
  clients: 'These recipients are CURRENT or PAST clients. You can reference their relationship with HNC ("since you\'ve trusted us with your home"). Don\'t introduce HNC.',
  both: 'Mixed audience of leads and clients. Stay neutral — don\'t assume prior knowledge but don\'t over-introduce.',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { vibe, offer, audience = 'both', tone = 'aloha' } = req.body || {};

    if (!vibe || !VIBE_GUIDANCE[vibe]) {
      return res.status(400).json({ error: 'Valid vibe required: ' + Object.keys(VIBE_GUIDANCE).join(', ') });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    // Build the user prompt with all the contextual hints
    const userPrompt = [
      `Vibe: ${vibe} — ${VIBE_GUIDANCE[vibe]}`,
      `Audience: ${audience} — ${AUDIENCE_GUIDANCE[audience] || AUDIENCE_GUIDANCE.both}`,
      `Tone: ${tone} — ${TONE_GUIDANCE[tone] || TONE_GUIDANCE.aloha}`,
      offer
        ? `OFFER (preserve EXACTLY — every number, date, percentage, and service reference must appear verbatim in the output): "${offer}"`
        : 'No specific offer — write evergreen content for this vibe. Skip the offer-callout box if no offer.',
      '',
      offer ? `Reminder: the offer above contains specific details. If the user wrote "${offer}", your output must contain those exact details. Do not change percentages, time windows, service types, or any numbers.` : '',
      'Generate the broadcast now. Return ONLY the JSON object — no markdown, no commentary.',
    ].filter(Boolean).join('\n');

    const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    }, TIMEOUTS.AI || 30000);

    if (!resp.ok) {
      const errText = await resp.text();
      await logError('ai-broadcast', new Error('Claude API ' + resp.status), { errText: errText.slice(0, 500) });
      return res.status(502).json({ error: 'AI generation failed', detail: 'Upstream ' + resp.status });
    }

    const data = await resp.json();
    const rawText = data?.content?.[0]?.text || '';

    // Parse the JSON response — Claude should return pure JSON per the system prompt
    let parsed;
    try {
      // Strip any accidental markdown fences just in case
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      await logError('ai-broadcast', parseErr, { rawText: rawText.slice(0, 500) });
      return res.status(502).json({ error: 'AI returned invalid JSON', detail: rawText.slice(0, 200) });
    }

    // Validate the required fields
    const required = ['subject', 'preheader', 'heading', 'intro', 'body_html', 'cta_text', 'cta_url'];
    for (const f of required) {
      if (!parsed[f] || typeof parsed[f] !== 'string') {
        return res.status(502).json({ error: `AI response missing field: ${f}`, partial: parsed });
      }
    }

    // Default the CTA URL if AI didn't supply a real one
    if (!parsed.cta_url.startsWith('tel:') && !parsed.cta_url.startsWith('http')) {
      parsed.cta_url = 'tel:8084685356';
    }

    return res.status(200).json({
      success: true,
      subject:    parsed.subject,
      preheader:  parsed.preheader,
      heading:    parsed.heading,
      intro:      parsed.intro,
      body_html:  parsed.body_html,
      cta_text:   parsed.cta_text,
      cta_url:    parsed.cta_url,
    });
  } catch (err) {
    await logError('ai-broadcast', err, {});
    return res.status(500).json({ error: err.message });
  }
}
