/**
 * Shared structured-summary prompt builder for Hawaii Natural Clean.
 *
 * Used by:
 *  - api/ai-summary.js  (manual "Generate" buttons on lead + client profiles)
 *  - api/run-task-automations.js  (auto-fired pre-call brief on Day 1 / Day 5)
 *
 * Output is a markdown brief with EXACTLY 6 sections — see RULES block in the
 * returned prompt. Frontend renders the markdown as HTML via simple regex
 * replacement (see renderSummaryHtml in index.html). Section order and emoji
 * markers are part of the contract — keep them stable so the renderer
 * doesn't need to special-case anything.
 *
 * Modes:
 *  - 'lead'      → "Lead intelligence briefing" framing (early-stage)
 *  - 'client'    → "Client intelligence briefing" framing (existing customer)
 *  - 'va_brief'  → "Pre-call briefing" framing (rep about to dial)
 */

export function buildSummaryPrompt({ mode = 'lead', data = {}, history = '' } = {}) {
  const introByMode = {
    lead:     'You are an intelligence assistant for Hawaii Natural Clean (a residential and commercial cleaning business in Hawaii). Generate a structured briefing for someone reviewing this LEAD.',
    client:   'You are an intelligence assistant for Hawaii Natural Clean (a residential and commercial cleaning business in Hawaii). Generate a structured briefing for someone reviewing this CLIENT.',
    va_brief: 'You are a pre-call briefing assistant for Hawaii Natural Clean (a residential and commercial cleaning business in Hawaii). Generate a structured brief for the rep about to make this call.',
  };

  const rules = [
    'OUTPUT FORMAT IS NON-NEGOTIABLE. Use EXACTLY the six sections below, in this order, with the exact markdown headers shown (including the emoji).',
    'Each section must contain markdown bullet items starting with "- ".',
    'If a section has no data, output a single bullet "- (none)". Do not skip the section.',
    'Be factual. Quote specific dates, dollar amounts, and message excerpts where relevant. Do not speculate about emotions, motivations, or causes.',
    'In the FLAGS section, surface anything that could easily be missed: gate codes, access instructions, allergies, pet info, complaints, mentions of competitors, payment issues, special requests, scheduling preferences, or anything unusual in their conversation history. This is the most important section.',
    'In RECOMMENDED NEXT ACTION, give one concrete, specific next step grounded in the data above. No filler.',
    'Do not include any preamble, explanation, or content outside the six sections.',
  ].join('\n');

  const structure = [
    '## 👤 Who',
    '- (name, type/segment, status, lead/customer since when)',
    '',
    '## 💰 Money',
    '- (LTV, MRR, payment method, recent invoice/payment status, quote amount)',
    '',
    '## 📅 Service',
    '- (last job, next scheduled, cadence, preferred cleaner, properties)',
    '',
    '## 📞 Comms',
    '- (last contact dates, SMS / call summary, response patterns — quote specific dates)',
    '',
    '## 🚩 Flags',
    '- (easy-to-miss items: access notes, allergies, pets, complaints, competitors, payment issues, scheduling quirks)',
    '',
    '## ➡️ Recommended next action',
    '- (one specific actionable next step)',
  ].join('\n');

  // Format the structured data block. Skip null/undefined/empty/—.
  const lines = [];
  const push = (k, v) => {
    if (v == null) return;
    if (typeof v === 'string' && (v.trim() === '' || v.trim() === '—')) return;
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
  push('Notes', data.notes);

  const briefingPurpose = mode === 'va_brief'
    ? '\nPURPOSE: This brief is for a sales rep about to call this lead. The rep needs to walk into the call knowing exactly what was said, what was offered, and what objections might come up. The Flags section is the rep\'s lifeline — be thorough.\n'
    : '';

  const historyBlock = history && history.trim()
    ? `\n=== FULL CONVERSATION HISTORY (SMS + call summaries from OpenPhone) ===\n${history.trim()}\n=== END HISTORY ===\n`
    : '';

  return [
    introByMode[mode] || introByMode.lead,
    briefingPurpose,
    'RULES:',
    rules,
    '',
    'EXACT STRUCTURE TO PRODUCE:',
    structure,
    '',
    '---',
    '=== STRUCTURED DATA ===',
    lines.length ? lines.join('\n') : '(no structured data provided)',
    historyBlock,
    '---',
    'Now produce the brief using the exact structure above. Markdown only. No preamble.',
  ].join('\n');
}
