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
  const hasPhone = !!phone && phone !== '\u2014';
  const hasEmail = !!email && email !== '\u2014';
  const firstName = (lead.name || lead.contact_name || '').split(' ')[0] || 'there';
  const daysSinceCreated = lead.created_at
    ? Math.floor((Date.now() - new Date(lead.created_at).getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const daysSinceQuote = lead.quote_sent_at
    ? Math.floor((Date.now() - new Date(lead.quote_sent_at).getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const daysSinceReply = lead.last_responded_at
    ? Math.floor((Date.now() - new Date(lead.last_responded_at).getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const hasReplied = !!lead.last_responded_at;

  // Today's date in Hawaii time — prevents the AI from referencing past dates
  // as upcoming. (Same fix as in lead-followup-generate.js.)
  const todayHawaii = new Date().toLocaleDateString('en-US', {
    timeZone: 'Pacific/Honolulu',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // Compact transcript so we don't bloat tokens
  const recentSms = (history?.sms || []).slice(-15).map(m => ({
    direction: m.direction,
    body: (m.body || '').slice(0, 240),
    when: m.created_at,
  }));
  const recentCalls = (history?.calls || []).slice(-4).map(c => ({
    direction: c.direction,
    duration: c.duration,
    answered: c.answered,
    when: c.created_at,
  }));

  // Pull dollar-amounts visible in SMS history. The lead may have been quoted
  // by SMS without the structured quote ever being written. The AI needs to
  // know it can reference these but shouldn't invent them.
  const pricesInSms = [];
  recentSms.forEach(m => {
    const matches = (m.body || '').match(/\$\s?\d{2,5}(?:[.,]\d{2})?/g);
    if (matches) matches.forEach(p => pricesInSms.push(p));
  });
  const hasStructuredQuote = !!lead.quote_total;
  const hasPriceEvidence = hasStructuredQuote || pricesInSms.length > 0;

  // Stage-specific context — what the situation actually IS, not just what
  // the stage is named.
  let stageContext = '';
  if (stage === 'New inquiry' && daysSinceCreated <= 1) {
    stageContext = 'BRAND NEW lead from today or yesterday. Speed is everything: leads called/texted within 1 hour convert dramatically better than those waiting 24h+. If no contact has happened yet, this is the highest-urgency action.';
  } else if (stage === 'New inquiry' && daysSinceCreated > 1) {
    stageContext = 'Lead came in days ago and hasn\'t been quoted yet. Something fell through the cracks. Get them a quote ASAP — they may have already gone with a competitor, but a warm reach-out can still recover them.';
  } else if (stage === 'Quoted' && !hasReplied && daysSinceQuote >= 1 && daysSinceQuote <= 3) {
    stageContext = 'Quoted ' + daysSinceQuote + ' day(s) ago, no reply. Sweet spot for a follow-up — not too soon to feel pushy, not so late they\'ve forgotten. Goal: get them to engage so we can address objections.';
  } else if (stage === 'Quoted' && !hasReplied && daysSinceQuote > 3 && daysSinceQuote <= 7) {
    stageContext = 'Quoted ' + daysSinceQuote + ' days ago, no reply. They\'re cooling. Warm, no-pressure check-in. Often this is when a lead is comparing quotes — a friendly nudge can tip them back to us.';
  } else if (stage === 'Quoted' && !hasReplied && daysSinceQuote > 7) {
    stageContext = 'Quoted ' + daysSinceQuote + ' days ago, no reply. Going cold. This is the last-ditch nudge before they roll into Closed lost. Keep it short and human. Don\'t guilt them.';
  } else if (stage === 'Quoted' && hasReplied) {
    stageContext = 'They replied at some point — READ THE SMS HISTORY before recommending. Respond to what they actually said. If they asked a question, answer it. If they raised an objection, address it. Don\'t pretend the conversation didn\'t happen.';
  } else if (stage === 'Walkthrough requested') {
    stageContext = 'They asked for a walkthrough but haven\'t locked in a date/time. These leads are HOT — they\'ve self-identified as serious. Priority is getting on their calendar TODAY. A call beats a text here.';
  } else if (stage === 'Long-Term Follow-Up' && hasPriceEvidence) {
    stageContext = 'Cold lead in active follow-up. They got a quote and went silent. Light, no-pressure check-in. The aim is to leave the door open without being pushy.';
  } else if (stage === 'Long-Term Follow-Up' && !hasPriceEvidence) {
    stageContext = 'Cold lead in follow-up, no clear quote on record. May have been a phone-only conversation. Open-ended re-engagement only. Don\'t claim to have sent an estimate. Keep it warm and short.';
  } else {
    stageContext = 'Standard follow-up. Be specific to their actual situation from notes/history.';
  }

  // CHANNEL SELECTION LOGIC — these are the rules that decide call vs text vs email.
  // This is the conversion lever: picking the right channel for the right lead.
  const channelGuidance = `CHANNEL SELECTION — pick what's most likely to convert THIS lead:

CALL — recommend when ANY of these are true:
  - Stage is "Walkthrough requested" (they want to talk in person, calls beat texts)
  - Lead's last 1-2 texts are long, exploratory, or contain multiple questions (they're verbal-style)
  - 2+ texts have gone unanswered (text fatigue — voice changes the channel)
  - Lead explicitly asked to be called ("call me", "give me a ring", "what's your number")
  - Lead has been Quoted 5-10 days with no reply AND phone is on file (a call has higher conversion than yet another text)
  - Quote total is $500+ (higher-value jobs warrant the personal touch)
  ONLY recommend call if phone is on file. Best call window is weekdays 9am-5pm Hawaii time. If it's outside business hours, recommend text or skip until tomorrow morning.

TEXT — the default for most leads:
  - Quoted within last 1-4 days, no reply (early-window nudge)
  - Lead originally inquired by SMS and replied by SMS (match their preferred channel)
  - Short follow-ups, calendar reminders, simple questions
  - Best for transactional leads (one-time move-out clean, etc.)

EMAIL — recommend when ANY of these are true:
  - Lead originally came in by email and never gave a phone, OR uses email to communicate complex stuff
  - You're sending a quote breakdown, multiple pricing options, or a written proposal
  - Lead asked a specific question that warrants a thorough written answer
  - Commercial leads (they expect written records)
  ONLY recommend email if email is on file.

SKIP — recommend when:
  - Lead said "I'll get back to you by [date]" and that date hasn't passed yet
  - Lead replied within last 12 hours and we just need to give them space
  - It's a weekend morning or evening and the action would feel intrusive
  - There's literally no new event since the last touchpoint and it'd be the 3rd contact this week (don't burn the lead with over-contact)`;

  return [
    {
      role: 'user',
      content: `You are advising ${assistantName}, the new admin assistant for Hawaii Natural Clean (HNC) — a small, locally-owned residential and commercial cleaning business on Oahu and Maui.

Your ONE job: look at this lead and decide the SINGLE highest-conversion-probability action she should take right now. You are optimizing for booked jobs, not for activity. A "skip" recommendation today is better than a wrong text that annoys the lead.

TODAY'S DATE: ${todayHawaii} (Hawaii time)

==== LEAD ====
- Name: ${lead.name || '(no name)'}
- First name to address them by: ${firstName}
- Stage: ${stage}
- Days since lead came in: ${daysSinceCreated ?? '?'}
- Days since quote sent: ${daysSinceQuote ?? '(no quote sent)'}
- Days since lead last replied: ${daysSinceReply ?? '(never replied)'}
- Service interested in: ${lead.service || '(unknown)'}
- Property: ${lead.beds ? lead.beds + 'bd ' : ''}${lead.baths ? lead.baths + 'ba ' : ''}${lead.sqft ? lead.sqft + 'sqft' : ''}
- Quote total: ${hasStructuredQuote ? '$' + lead.quote_total : (pricesInSms.length > 0 ? 'not in DB but prices in SMS: ' + pricesInSms.join(', ') : 'NO QUOTE on record and NO prices in SMS history')}
- Phone on file: ${hasPhone ? phone : 'NO'}
- Email on file: ${hasEmail ? email : 'NO'}
- Internal notes: ${lead.notes ? lead.notes.slice(0, 500) : '(none)'}

==== SITUATION ====
${stageContext}

==== RECENT SMS (last 15, oldest first) ====
${recentSms.length === 0 ? '(no SMS history)' : recentSms.map(m => `  [${m.direction}] ${m.when}: ${m.body}`).join('\\n')}

==== RECENT CALLS (last 4) ====
${recentCalls.length === 0 ? '(no calls)' : recentCalls.map(c => `  [${c.direction}] ${c.when} duration=${c.duration}s answered=${c.answered}`).join('\\n')}

==== ${channelGuidance} ====

==== PRIORITY (1=most urgent today, 10=least) ====
1-2: HOT — they replied in last 48h OR walkthrough requested OR brand-new today. Act today, ideally within hours.
3-4: WARM — Quoted 1-4 days ago no reply, normal follow-up cadence.
5-6: COOLING — Quote 5-10 days old no reply, going cold. Last-chance window.
7-8: COLD — Quote 11+ days, in Long-Term Follow-Up stage. Long-shot nudge.
9-10: SKIP — wait-state, recently contacted, low-value, or do-nothing.

==== HOW TO DRAFT THE MESSAGE (for text/email actions) ====

OPENING — mandatory:
  - SMS: "Aloha ${firstName}!" or "Aloha ${firstName},"
  - Email: "Aloha ${firstName},"
  - NEVER: "Hey", "Hi", "Hello", "Dear", "Hi there", "Hope this email finds you well", "I hope you're doing well"

SIGN-OFF — mandatory:
  - Always: "— ${assistantName} from Hawaii Natural Clean" on its own line at the end
  - Never abbreviate to just the first name

BANNED PHRASES (these are CRM-speak, never use them):
  - "just checking in", "checking in on"
  - "following up on that", "wanted to follow up", "wanted to reach out"
  - "circling back", "touching base"
  - "I hope this finds you well", "I hope this email finds you well"
  - "per our last conversation", "as per"

TONE:
  - Warm, friendly, positive, professional. Aloha spirit = hospitality and genuine care.
  - Standard polished English. NO pidgin. Never "da kine", "shoots", "brah", "howzit", "stoked".
  - Sound like a Hawaii small business owner personally texting a neighbor — not a CRM, not marketing copy.
  - Be specific. If notes or history mention something concrete (a date, a property type, a question), reference it.
  - Better a 2-sentence message that feels real than a 5-sentence message stuffed with invented context.

LENGTH:
  - SMS: 1-3 short sentences. Under 320 characters total.
  - Email: 3-5 short paragraphs. Subject line short and specific to them — never generic "Following up" / "Checking in".
  - At most ONE 🌺 emoji per SMS. None in email.
  - NO em-dashes anywhere in the body. (The sign-off uses an em-dash before the name; that's the only one allowed.)

PRICE / QUOTE RULES — critical for trust:
  - If "Quote total" above is a real dollar amount, you may reference it: "the $${hasStructuredQuote ? lead.quote_total : 'X'} we talked about" — naturally, never robotically as "your quote".
  - If prices are in SMS history but not in DB, you may reference those naturally too.
  - If neither — DO NOT claim to have sent an estimate. Don't say "your quote" or "the price I gave you" or "the estimate I sent". Use open-ended phrasing: "your inquiry", "your interest in [service]", "happy to walk through pricing whenever".
  - NEVER invent a dollar amount.

DATE RULES:
  - Today is ${todayHawaii}. NEVER reference a date that has already passed as if it's still upcoming.
  - If SMS history mentions a date that's now past, treat it as expired. Use "the date we discussed didn't work out" or just leave dates out.
  - NEVER invent a specific date the lead never proposed.

ADDRESS / PRIVACY:
  - You may reference city or town ("your home in Kula", "your place in Mililani"). Cities are friendly local context.
  - NEVER mention street number, street name, apartment number, building name, or zip code. That's creepy.

==== TALKING POINTS (for ALL actions, including skip) ====
Write 2-3 short bullets the assistant can use as cues. For calls: what to listen for, what to mention, expected objections + how to handle them. For texts/emails: why this draft is structured this way. For skip: why we're holding off and what to watch for.

==== CONVERSION PLAYBOOK — apply these heuristics ====
- Speed wins. Sub-1-hour response time on new leads roughly doubles conversion vs sub-24h. If "Days since lead came in" is 0 and no contact yet, this is your highest-priority action.
- Specificity converts. A message that references the lead's actual property, service, or last question outperforms generic "checking in" by ~3x.
- Calls outperform texts on high-value leads. Quote $500+, walkthroughs, commercial inquiries — recommend a call when phone is available and it's business hours.
- Don't over-contact. 3rd contact in a week without a reply trains the lead to ignore. Recommend skip unless something has materially changed.
- Address objections directly. If the lead said "too expensive" or "comparing quotes," the next message should ADDRESS that, not change subject.
- Match their channel. If they texted us, text them back. If they emailed, email back. Switching channels feels jarring unless there's a reason.

==== BEFORE YOU OUTPUT — verify ====
  ✓ Did I pick the channel most likely to convert THIS lead, not just the easiest one?
  ✓ Is the priority calibrated to actual urgency, not "all 5"?
  ✓ If text or email: does the message open with "Aloha ${firstName}"?
  ✓ Does the message AVOID every banned phrase?
  ✓ Did I check that any specific dollar amount or date I reference is supported by real data above?
  ✓ Does the message reference any street/address/apartment? If yes — REWRITE.
  ✓ Would this feel like a real Hawaii small-business owner wrote it, not a CRM?

==== OUTPUT FORMAT (STRICT) ====
Return ONLY this JSON object. No preamble. No "Here's the recommendation:". No markdown code fences. The very first character must be { and the last must be }.

{
  "action_type": "call" | "text" | "email" | "skip",
  "priority": <integer 1-10>,
  "reasoning": "one sentence on why this is the right action right now",
  "talking_points": "- bullet 1\\n- bullet 2\\n- bullet 3",
  "draft_subject": "..." (email only — omit for sms/call/skip),
  "draft_message": "..." (text/email only — omit for call/skip)
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
