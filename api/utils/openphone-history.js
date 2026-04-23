/**
 * openphone-history.js
 *
 * Shared utility that fetches conversation history directly from the
 * OpenPhone API for a given phone number. Used by:
 *   - run-review-requests.js  (sentiment before sending review request)
 *   - ai-personalize.js       (context for lead follow-up personalization)
 *   - ai-summary.js prompt    (client intelligence briefing)
 *
 * Fetches:
 *   - SMS messages: up to 200 (2 pages of 100) — covers months of history
 *   - Call summaries: up to 25 most recent calls with AI summaries
 *
 * Returns a formatted string ready to paste into a Claude prompt.
 */

const OPENPHONE_BASE = 'https://api.openphone.com/v1';

/**
 * Get your HNC phone number ID from OpenPhone (cached per cold start).
 */
let _cachedPhoneNumberId = null;
async function getPhoneNumberId(apiKey) {
  if (_cachedPhoneNumberId) return _cachedPhoneNumberId;
  const resp = await fetch(`${OPENPHONE_BASE}/phone-numbers`, {
    headers: { 'Authorization': apiKey },
  });
  if (!resp.ok) throw new Error(`OpenPhone phone-numbers failed: ${resp.status}`);
  const data = await resp.json();
  const numbers = data.data || [];
  if (!numbers.length) throw new Error('No OpenPhone phone numbers found');
  _cachedPhoneNumberId = numbers[0].id;
  return _cachedPhoneNumberId;
}

/**
 * Fetch SMS history for a phone number.
 * @param {string} apiKey  - QUO_API_KEY
 * @param {string} phoneNumberId - your OpenPhone phone number ID
 * @param {string} participantPhone - client phone in E.164 format
 * @param {number} maxMessages - total messages to fetch (default 200)
 * @returns {Array} array of { direction, text, createdAt }
 */
async function fetchSmsHistory(apiKey, phoneNumberId, participantPhone, maxMessages = 200) {
  const messages = [];
  let pageToken = null;
  const pageSize = 100; // OpenPhone max per page

  while (messages.length < maxMessages) {
    const params = new URLSearchParams({
      phoneNumberId,
      participants: participantPhone,
      maxResults: String(Math.min(pageSize, maxMessages - messages.length)),
    });
    if (pageToken) params.set('pageToken', pageToken);

    const resp = await fetch(`${OPENPHONE_BASE}/messages?${params}`, {
      headers: { 'Authorization': apiKey },
    });
    if (!resp.ok) break;

    const data = await resp.json();
    const batch = data.data || [];
    messages.push(...batch.map(m => ({
      direction: m.direction,  // 'incoming' | 'outgoing'
      text: m.text || m.body || '',
      createdAt: m.createdAt,
    })));

    pageToken = data.nextPageToken;
    if (!pageToken || batch.length === 0) break;
  }

  // Return chronologically (oldest first)
  return messages.reverse();
}

/**
 * Fetch call summaries for a phone number.
 * @param {string} apiKey
 * @param {string} phoneNumberId
 * @param {string} participantPhone
 * @param {number} maxCalls - max calls to fetch (default 25)
 * @returns {Array} array of { direction, duration, createdAt, summary }
 */
async function fetchCallSummaries(apiKey, phoneNumberId, participantPhone, maxCalls = 25) {
  const params = new URLSearchParams({
    phoneNumberId,
    participants: participantPhone,
    maxResults: String(maxCalls),
  });

  const resp = await fetch(`${OPENPHONE_BASE}/calls?${params}`, {
    headers: { 'Authorization': apiKey },
  });
  if (!resp.ok) return [];

  const data = await resp.json();
  const calls = data.data || [];

  // Fetch summaries for each call that has one
  const withSummaries = await Promise.all(calls.map(async (call) => {
    let summary = null;
    try {
      const sResp = await fetch(`${OPENPHONE_BASE}/calls/${call.id}/summary`, {
        headers: { 'Authorization': apiKey },
      });
      if (sResp.ok) {
        const sData = await sResp.json();
        summary = sData.data?.summary || null;
      }
    } catch (_) {}
    return {
      direction: call.direction,
      durationSeconds: call.duration,
      createdAt: call.createdAt,
      summary,
    };
  }));

  return withSummaries.reverse(); // chronological
}

/**
 * Main export — fetches full conversation history and formats it for Claude.
 *
 * @param {string} clientPhone - client phone number (any format)
 * @param {object} opts
 * @param {string} opts.apiKey   - QUO_API_KEY env var value
 * @param {number} [opts.maxSms=200]   - max SMS messages to fetch
 * @param {number} [opts.maxCalls=25]  - max call summaries to fetch
 * @returns {Promise<string>} formatted history string, or empty string if nothing found
 */
export async function getOpenPhoneHistory(clientPhone, { apiKey, maxSms = 200, maxCalls = 25 } = {}) {
  if (!clientPhone || !apiKey) return '';

  // Normalize to E.164
  const digits = clientPhone.replace(/\D/g, '');
  const e164 = clientPhone.startsWith('+') ? clientPhone.replace(/[^0-9+]/g, '') : `+1${digits}`;

  try {
    const phoneNumberId = await getPhoneNumberId(apiKey);
    const [smsHistory, callSummaries] = await Promise.all([
      fetchSmsHistory(apiKey, phoneNumberId, e164, maxSms),
      fetchCallSummaries(apiKey, phoneNumberId, e164, maxCalls),
    ]);

    const lines = [];

    if (smsHistory.length > 0) {
      lines.push(`SMS history (${smsHistory.length} messages):`);
      for (const msg of smsHistory) {
        const who = msg.direction === 'incoming' ? 'Client' : 'HNC';
        const date = msg.createdAt ? new Date(msg.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        if (msg.text) lines.push(`[${date}] ${who}: ${msg.text}`);
      }
      lines.push('');
    }

    if (callSummaries.length > 0) {
      lines.push(`Call history (${callSummaries.length} calls):`);
      for (const call of callSummaries) {
        const date = call.createdAt ? new Date(call.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const dur = call.durationSeconds ? `${Math.round(call.durationSeconds / 60)}min` : '';
        lines.push(`[${date}] ${call.direction} call${dur ? ` (${dur})` : ''}`);
        if (call.summary) lines.push(`  Summary: ${call.summary}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    console.error('[openphone-history] Failed to fetch history:', err.message);
    return '';
  }
}
