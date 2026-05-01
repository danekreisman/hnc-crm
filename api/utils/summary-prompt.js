/**
 * Shared structured-summary prompt builder for Hawaii Natural Clean.
 *
 * Used by:
 *  - api/ai-summary.js  (manual "Generate" buttons on lead + client profiles)
 *  - api/run-task-automations.js  (auto-fired pre-call brief on Day 1 / Day 5)
 *
 * TWO OUTPUT FORMATS:
 *
 *   mode='lead' or 'client' → SINGLE "🚩 Things to know" section.
 *     Surfaces buried info (preferences, complaints, access notes, open
 *     threads, key context). Does NOT restate profile fields the user can
 *     already see on the screen.
 *
 *   mode='va_brief' → 6-section structured pre-call briefing.
 *     Different surface (Tasks page), different consumer (rep prepping for a
 *     call), so it earns the more comprehensive format.
 *
 * Frontend renders the markdown via simple regex (renderSummaryHtml in
 * index.html). The renderer is mode-agnostic — turns `## headers` +
 * `- bullets` + `**bold**` into HTML.
 */

export function buildSummaryPrompt({ mode = 'lead', data = {}, history = '' } = {}) {
  if (mode === 'va_brief') {
    return _buildVaBriefPrompt({ data, history });
  }
  return _buildThingsToKnowPrompt({ mode, data, history });
}

function _formatDataLines(data) {
  const lines = [];
  const push = (k, v) => {
    if (v == null) return;
    if (typeof v === 'string' && (v.trim() === '' || v.trim() === '\u2014')) return;
    lines.push(`${k}: ${v}`);
  };
  push('Name', data.name);
  push('Type', data.type);
  push('Status', data.status);
  push('Stage (pipeline)', data.stage);
  push('Service', data.service);
  push('Frequency', data.frequency);
  push('Customer since', data.since);
  push('Address', data.address);
  push('Property', data.property);
  if (data.condition) push('Condition score', `${data.condition}/10`);
  push('Quote total', data.quote_total != null ? `$${Number(data.quote_total).toFixed(2)}` : null);
  push('Lifetime value', data.ltv);
  push('Monthly revenue', data.mrr);
  push('Last job', data.last_job);
  push('Next job', data.next_job);
  push('Preferred cleaner', data.cleaner);
  push('Payment method', data.payment);
  push('Properties', data.properties);
  push('Recent job history', data.recent_jobs);
  push('Recent SMS (in CRM inbox)', data.recent_messages);
  push('Notes (form submission + manual)', data.notes);
  return lines;
}

function _buildThingsToKnowPrompt({ mode, data, history }) {
  const intro = mode === 'lead'
    ? 'You are reviewing a NEW LEAD for Hawaii Natural Clean (residential + commercial cleaning in Hawaii). The user can already see name, service, property, quote, stage, and basic info elsewhere on the screen. Your job is to mine the notes + any conversation history and surface buried context that would otherwise be missed.'
    : 'You are reviewing an EXISTING CLIENT for Hawaii Natural Clean (residential + commercial cleaning in Hawaii). The user can already see name, LTV, last/next job, preferred cleaner, and properties elsewhere on the screen. Your job is to mine the conversation history and surface the buried stuff that would otherwise take scrolling through a year of messages to find.';

  const rules = [
    'OUTPUT EXACTLY ONE SECTION with the markdown header "## \uD83D\uDEA9 Things to know" followed by markdown bullets ("- ").',
    'Each bullet is one short sentence. Quote specific dates and dollar amounts when relevant. Use **bold** for the most critical items.',
    'WHAT BELONGS IN BULLETS:',
    '  - Stated preferences ("wants doors closed", "prefers fragrance-free", "9am start", "no shoes inside")',
    '  - Complaints or past issues, with dates when known ("complained about bathroom on 2/14")',
    '  - Access & logistics ("gate code 4829", "use back entrance", "two large dogs", "park on street")',
    '  - Open threads \u2014 questions they asked that we never answered, OR things we promised and didn\'t deliver',
    '  - Key context they shared (out of country, planning a second property, expecting guests, schedule constraints, etc.)',
    '  - Anything unusual in their conversation history worth flagging',
    'WHAT DOES NOT BELONG: tone analysis, emotional reads, restatements of fields already shown elsewhere (LTV, last job date, service type, name, address), filler like "they seem interested" or "appears engaged".',
    'If you find nothing buried worth surfacing, output exactly: "- Nothing notable in their history yet \u2014 profile speaks for itself."',
    'NO PREAMBLE. NO CODE FENCES. NO TRAILING COMMENTARY. Output starts with "## \uD83D\uDEA9 Things to know" and ends with the last bullet.',
  ].join('\n');

  const dataLines = _formatDataLines(data);

  const historyBlock = history && history.trim()
    ? `\n=== CONVERSATION HISTORY (SMS + call summaries from OpenPhone) ===\n${history.trim()}\n=== END HISTORY ===\n`
    : '';

  return [
    intro,
    '',
    'RULES:',
    rules,
    '',
    '---',
    '=== STRUCTURED DATA (already visible on the profile \u2014 only mine for buried context) ===',
    dataLines.length ? dataLines.join('\n') : '(no structured data provided)',
    historyBlock,
    '---',
    'Now produce the brief in the required format. Markdown only. No preamble.',
  ].join('\n');
}

function _buildVaBriefPrompt({ data, history }) {
  const intro = 'You are a pre-call briefing assistant for Hawaii Natural Clean (a residential and commercial cleaning business in Hawaii). Generate a structured brief for the rep about to make this call.';

  const rules = [
    'OUTPUT FORMAT IS NON-NEGOTIABLE. Use EXACTLY the six sections below, in this order, with the exact markdown headers shown (including the emoji).',
    'Each section must contain markdown bullet items starting with "- ". Use "**Label:**" inline for the field name when helpful.',
    'Aim for 2-4 bullets per section, each one short and scannable. If a section truly has no data, output a single bullet "- (none)".',
    'Be factual. Quote specific dates, dollar amounts, and message excerpts where relevant. Do not speculate about emotions, motivations, or causes.',
    'In FLAGS, surface anything easy to miss: gate codes, access notes, allergies, pets, complaints, competitors, payment issues, scheduling quirks, open threads. Most important section.',
    'In RECOMMENDED NEXT ACTION, give one concrete next step grounded in the data.',
    'NO PREAMBLE. NO CODE FENCES. NO TRAILING COMMENTARY. Output starts with "## \uD83D\uDC64 Who" and ends with the last bullet.',
  ].join('\n');

  const structure = [
    '## \uD83D\uDC64 Who',
    '- (name, type/segment, status, lead/customer since when)',
    '',
    '## \uD83D\uDCB0 Money',
    '- (LTV, MRR, payment method, recent invoice/payment status, quote amount)',
    '',
    '## \uD83D\uDCC5 Service',
    '- (last job, next scheduled, cadence, preferred cleaner, properties)',
    '',
    '## \uD83D\uDCDE Comms',
    '- (last contact dates, SMS / call summary, response patterns \u2014 quote specific dates)',
    '',
    '## \uD83D\uDEA9 Flags',
    '- (easy-to-miss items: access notes, allergies, pets, complaints, competitors, payment issues, scheduling quirks)',
    '',
    '## \u27A1\uFE0F Recommended next action',
    '- (one specific actionable next step)',
  ].join('\n');

  const briefingPurpose = '\nPURPOSE: This brief is for a sales rep about to call this lead. The rep needs to walk into the call knowing exactly what was said, what was offered, and what objections might come up. The Flags section is the rep\'s lifeline \u2014 be thorough.\n';

  const dataLines = _formatDataLines(data);

  const historyBlock = history && history.trim()
    ? `\n=== FULL CONVERSATION HISTORY (SMS + call summaries from OpenPhone) ===\n${history.trim()}\n=== END HISTORY ===\n`
    : '';

  return [
    intro,
    briefingPurpose,
    'RULES:',
    rules,
    '',
    'EXACT STRUCTURE TO PRODUCE:',
    structure,
    '',
    '---',
    '=== STRUCTURED DATA ===',
    dataLines.length ? dataLines.join('\n') : '(no structured data provided)',
    historyBlock,
    '---',
    'Now produce the brief using the exact structure above. Markdown only. No preamble.',
  ].join('\n');
}
