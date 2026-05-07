/**
 * api/utils/generate-brief.js
 *
 * Shared utility: generate a structured AI briefing for a lead.
 *
 * Output is the bullet-formatted "📋 Quick read / 🚩 Watch for / 💡 Try this"
 * brief used to populate the `tasks.ai_brief` field. The UI renders this as a
 * collapsible "✨ AI brief" panel on each task (index.html ~L19382).
 *
 * History: extracted from run-task-automations.js on 2026-05-07 so the
 * stage_entered create_va_task handler in run-automations.js could call it
 * too — every Tide cadence task now gets context-aware AI intel for the
 * cleaner alongside the static template description.
 *
 * Dependencies (must remain available wherever this is called):
 *   - process.env.QUO_API_KEY
 *   - process.env.ANTHROPIC_API_KEY
 *   - api/utils/openphone-history.js
 *   - api/utils/with-timeout.js
 *   - api/utils/summary-prompt.js
 *
 * Fail-soft: returns null on any error. Callers should treat null as "no
 * brief available" — never block the surrounding work on this function.
 */

import { getOpenPhoneHistory } from './openphone-history.js';
import { fetchWithTimeout } from './with-timeout.js';
import { buildSummaryPrompt } from './summary-prompt.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

/**
 * @param {object} lead - lead record (needs phone, name, service, quote_total, address, notes)
 * @param {string} purpose - hint describing why the brief is being generated.
 *   Recognized values: 'day1', 'reengagement', 'tide_quoted_followup',
 *   'tide_inquiry_followup', 'tide_walkthrough_confirm', 'tide_lost_dripback'.
 *   Anything else falls back to a generic note.
 * @returns {Promise<string|null>} the brief text or null on failure
 */
export async function generateCallBrief(lead, purpose) {
  try {
    const history = lead.phone ? await getOpenPhoneHistory(lead.phone, {
      apiKey: process.env.QUO_API_KEY,
      maxSms: 100,
      maxCalls: 10,
    }) : '';

    // Surface the call/touch purpose at the top of the rep's brief by
    // prepending it to the Notes field — the structured prompt template
    // takes care of the rest of the format.
    const purposeNote = purposeNoteFor(purpose);

    const prompt = buildSummaryPrompt({
      mode: 'va_brief',
      data: {
        name: lead.name,
        service: lead.service,
        quote_total: lead.quote_total,
        address: lead.address,
        notes: lead.notes ? `${purposeNote}\n\n${lead.notes}` : purposeNote,
      },
      history,
    });

    const resp = await fetchWithTimeout(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 45000); // 45s — Sonnet on heavy OpenPhone history can exceed the 15s default

    const data = await resp.json();
    return data.content?.[0]?.text || null;
  } catch (err) {
    // Fail-soft. Caller decides what to do with null.
    console.error('[generate-brief] AI brief failed:', err.message);
    return null;
  }
}

function purposeNoteFor(purpose) {
  switch (purpose) {
    case 'day1':
      return 'CALL PURPOSE: Day-1 follow-up call. Quote went out yesterday — confirm receipt, answer questions, push toward booking.';
    case 'reengagement':
      return 'CALL PURPOSE: Day-5 re-engagement call. Lead got a quote 5 days ago and has not booked. Surface specific objections and any unanswered questions from their conversation.';
    case 'tide_quoted_followup':
      return 'TASK PURPOSE: Tide Quoted-stage cadence touch. Lead has an outstanding quote and the cadence is reaching out for a check-in. Highlight any signals from their history about price sensitivity, timing, or unanswered questions so the rep can adapt the suggested message.';
    case 'tide_inquiry_followup':
      return 'TASK PURPOSE: Tide New Inquiry cadence touch. Lead reached out but does not have a quote yet. Brief should focus on what they originally asked for, any specifics from earlier conversation, and what info we still need to send a quote.';
    case 'tide_walkthrough_confirm':
      return 'TASK PURPOSE: Tide Walkthrough confirmation. Lead asked for a walkthrough but date/time may not be locked in. Brief should surface anything from prior conversation about scheduling preferences, scope of the space, or access details.';
    case 'tide_lost_dripback':
      return 'TASK PURPOSE: Tide Closed-lost re-engagement touch. This lead went cold weeks ago. Brief should look for any reason from history that the timing might now be different — recent move, new property, season change, prior price objection that could be addressed.';
    default:
      return `TASK PURPOSE: ${purpose || 'general follow-up'}. Surface anything from history that helps the rep tailor the message.`;
  }
}
