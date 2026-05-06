/**
 * Shared logic to generate one AI recommendation for a single lead.
 * Used by /api/run-lead-recommendations (cron) and
 * /api/refresh-lead-recommendation (on-demand).
 *
 * Returns the inserted lead_recommendations row, or null if the lead was
 * deemed not actionable today (in which case nothing is written).
 */

import { fetchWithTimeout, TIMEOUTS } from './with-timeout.js';
import { getOpenPhoneHistory } from './openphone-history.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Skip leads that obviously don't need a rec right now.
 * Cheap pre-filter so we don't waste Claude calls on leads that auto-fail.
 */
export function isLeadActionable(lead) {
  if (!lead || !lead.id) return false;
  if (lead.do_not_contact) return false;
  if (['Closed won', 'Closed lost'].includes(lead.stage)) return false;
  return true;
}

/**
 * Build the AI prompt. Keeps the schema strict so JSON parsing is reliable.
 */
function buildPrompt(lead, history, assistantName) {
  const stage = lead.stage || 'New inquiry';
  const phone = lead.phone || '';
  const email = lead.email || '';
  const hasPhone = !!phone && phone !== '—';
  const hasEmail = !!email && email !== '—';
  const daysSinceCreated = lead.created_at
    ? Math.floor((Date.now() - new Date(lead.created_at).getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const daysSinceQuote = lead.quote_sent_at
    ? Math.floor((Date.now() - new Date(lead.quote_sent_at).getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const daysSinceReply = lead.last_responded_at
    ? Math.floor((Date.now() - new Date(lead.last_responded_at).getTime()) / (24 * 60 * 60 * 1000))
    : null;

  // Compact transcript so we don't bloat tokens
  const recentSms = (history?.sms || []).slice(-12).map(m => ({
    direction: m.direction,
    body: (m.body || '').slice(0, 200),
    when: m.created_at,
  }));
  const recentCalls = (history?.calls || []).slice(-3).map(c => ({
    direction: c.direction,
    duration: c.duration,
    answered: c.answered,
    when: c.created_at,
  }));

  return [
    {
      role: 'user',
      content: `You are advising ${assistantName}, the new admin assistant for Hawaii Natural Clean (HNC), a residential and commercial cleaning company on Oahu and Maui. Your job: look at this one lead and recommend ONE action she should take right now, OR tell her to skip them today.

Lead info:
- Name: ${lead.name || '(no name)'}
- Stage: ${stage}
- Days since lead came in: ${daysSinceCreated ?? '?'}
- Days since quote sent: ${daysSinceQuote ?? '(no quote sent)'}
- Days since lead last replied: ${daysSinceReply ?? '(never replied)'}
- Service: ${lead.service || '(unknown)'}
- Quote total: ${lead.quote_total ? '$' + lead.quote_total : '(no quote)'}
- Phone on file: ${hasPhone ? 'yes' : 'no'}
- Email on file: ${hasEmail ? 'yes' : 'no'}
- Internal notes: ${lead.notes ? lead.notes.slice(0, 500) : '(none)'}

Recent SMS (last 12, oldest first):
${recentSms.length === 0 ? '(no SMS history)' : recentSms.map(m => `  [${m.direction}] ${m.when}: ${m.body}`).join('\n')}

Recent calls (last 3):
${recentCalls.length === 0 ? '(no calls)' : recentCalls.map(c => `  [${c.direction}] ${c.when} duration=${c.duration}s answered=${c.answered}`).join('\n')}

Pick ONE action:
- "call": phone call. Recommend this when the lead is verbal-style (long winding texts, asks specific questions, hasn't decided), or when texts have gone unanswered and a call is the next step. Only if phone is on file.
- "text": SMS via OpenPhone. Default for most quoted-but-no-reply leads. Friendly, concise, Hawaiian/local tone.
- "email": when lead originally inquired by email, when there's a long quote breakdown to share, or when the lead asked specific questions warranting a written response. Only if email is on file.
- "skip": today is too soon, or the lead is in a wait-state (e.g., they said "I'll get back to you Friday" and it's only Wednesday).

Priority scale 1-10:
- 1-2: hot — they replied recently, conversation is alive, act today
- 3-4: warm — quoted recently, expected to engage soon, normal cadence
- 5-6: cooling — quote going cold (5-10 days no reply)
- 7-8: cold — last-ditch nudge before write-off
- 9-10: skip — wait-state, do-nothing, or low-value

For text/email, draft the actual message body. Use the lead's first name.

TONE — strict rules, tested and proven for HNC:
- OPEN with "Aloha [firstName]," — this is the brand voice, not optional. NEVER "Hey", "Hi", "Hello", "Dear", "Hi there", "Hope this email finds you well".
- Warm, friendly, positive, professional. Aloha spirit means hospitality and genuine care.
- Standard polished English. NO pidgin or slang. Never "da kine", "shoots", "brah", "howzit", "stoked".
- Sound like a Hawaii small business owner personally texting a neighbor, NOT a sales CRM, NOT marketing copy.
- For SMS: 1-3 short sentences. A 🌺 emoji is welcome but not required, never more than one.
- For email: 3-5 short paragraphs. Subject line short and specific to them — avoid generic "Following up" / "Checking in" / "Just touching base".
- Sign off "— ${assistantName} from Hawaii Natural Clean" on its own line. Never shorten to just the first name. NO em-dashes anywhere else in the body.
- Tone reference (do NOT copy literally — match the warmth, not the words):
  "Aloha Sharon! Hope your move is going smooth. Whenever you're ready to lock in that move-out clean, just shoot me a text. — ${assistantName} from Hawaii Natural Clean"
- SMS under 320 chars total.

For call/skip, draft_message and draft_subject can be omitted.

For any action, write 2-3 short talking_points bullets the assistant can use as cues — what to listen for, what to mention, what objections to expect.

Reasoning: 1 sentence on WHY this is the right action right now. Plain English.

Respond with ONLY this JSON, nothing else:
{
  "action_type": "call" | "text" | "email" | "skip",
  "priority": 1-10,
  "reasoning": "one sentence on why",
  "talking_points": "- bullet 1\\n- bullet 2\\n- bullet 3",
  "draft_subject": "..." (email only),
  "draft_message": "..." (text/email only)
}`,
    },
  ];
}

export async function generateRecForLead(db, lead, opts = {}) {
  if (!isLeadActionable(lead)) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[generate-rec] ANTHROPIC_API_KEY not set — skipping');
    return null;
  }

  // Pull message history for context (best-effort)
  let history = { sms: [], calls: [] };
  if (lead.phone && lead.phone !== '—') {
    try {
      const phoneE164 = lead.phone.startsWith('+') ? lead.phone : '+1' + lead.phone.replace(/\D/g, '');
      history = await getOpenPhoneHistory(phoneE164, {
        apiKey: process.env.QUO_API_KEY,
        maxSms: 30,
        maxCalls: 5,
      }) || history;
    } catch (e) {
      console.warn('[generate-rec] history fetch failed:', e.message);
    }
  }

  const assistantName = opts.assistantName || 'the assistant';
  const messages = buildPrompt(lead, history, assistantName);

  const t0 = Date.now();
  let parsed;
  try {
    const resp = await fetchWithTimeout(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        messages,
      }),
      timeout: TIMEOUTS.LONG || 30000,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data?.content?.[0]?.text || '';
    // Strip code fences if present and parse
    const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('[generate-rec] AI call failed for lead', lead.id, ':', e.message);
    return null;
  }
  const ms = Date.now() - t0;

  // Validate AI output
  const validActions = ['call', 'text', 'email', 'skip'];
  if (!parsed || !validActions.includes(parsed.action_type)) {
    console.warn('[generate-rec] invalid AI output for lead', lead.id, ':', parsed);
    return null;
  }
  // Coerce priority
  let priority = parseInt(parsed.priority, 10);
  if (isNaN(priority) || priority < 1 || priority > 10) priority = 5;

  // Mark prior pending recs as superseded so the assistant doesn't see stale advice
  await db
    .from('lead_recommendations')
    .update({ status: 'superseded' })
    .eq('lead_id', lead.id)
    .eq('status', 'pending');

  // Insert the new rec
  const row = {
    lead_id: lead.id,
    action_type: parsed.action_type,
    priority,
    reasoning: (parsed.reasoning || '').slice(0, 500),
    talking_points: (parsed.talking_points || '').slice(0, 1500),
    draft_message: parsed.draft_message ? String(parsed.draft_message).slice(0, 2000) : null,
    draft_subject: parsed.draft_subject ? String(parsed.draft_subject).slice(0, 200) : null,
    status: 'pending',
    model: MODEL,
    generation_ms: ms,
  };
  const { data: inserted, error: insErr } = await db
    .from('lead_recommendations')
    .insert([row])
    .select()
    .single();
  if (insErr) {
    console.warn('[generate-rec] insert failed:', insErr.message);
    return null;
  }
  return inserted;
}
