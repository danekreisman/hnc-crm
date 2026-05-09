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
 * Bug fix 2026-05-08: previously this grabbed numbers[0].id unconditionally,
 * which only worked if the HNC line happened to be first in the API response.
 * Now matches by QUO_NUMBER suffix (last 10 digits) and falls back to the
 * single-number case if there's only one number on the account.
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

  // Try to match QUO_NUMBER if it's set
  const ourNumber = (process.env.QUO_NUMBER || '').replace(/\D/g, '').slice(-10);
  if (ourNumber) {
    const match = numbers.find(n => {
      const num = (n.phoneNumber || '').replace(/\D/g, '').slice(-10);
      return num === ourNumber;
    });
    if (match) {
      _cachedPhoneNumberId = match.id;
      return _cachedPhoneNumberId;
    }
  }
  // Fallback: single-number account
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
      const sResp = await fetch(`${OPENPHONE_BASE}/call-summaries/${call.id}`, {
        headers: { 'Authorization': apiKey },
      });
      if (sResp.ok) {
        const sData = await sResp.json();
        // OpenPhone returns `summary` as an array of bullet strings (matches
        // the shape webhook handler already expects in openphone-webhook.js).
        const raw = sData.data?.summary;
        summary = Array.isArray(raw) ? raw.join(' ') : (raw || null);
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

    // Try multiple phone formats. OpenPhone is inconsistent about how
    // numbers are stored vs queried — a number might be saved as
    // '9124332536' but the API only accepts '+19124332536' (or vice versa).
    // Try the most-likely format first; if it returns 0 results, fall back.
    const last10 = digits.slice(-10);
    const phoneFormats = [
      e164,                                  // '+19124332536'
      `+1${last10}`,                         // ensure +1 prefix
      last10,                                // bare 10 digits
      digits,                                // raw digits as given
    ].filter((v, i, a) => v && a.indexOf(v) === i); // dedupe + remove empties

    let smsHistory = [];
    let callSummaries = [];
    let successFormat = null;

    for (const tryPhone of phoneFormats) {
      const [sms, calls] = await Promise.all([
        fetchSmsHistory(apiKey, phoneNumberId, tryPhone, maxSms),
        fetchCallSummaries(apiKey, phoneNumberId, tryPhone, maxCalls),
      ]);
      if (sms.length > 0 || calls.length > 0) {
        smsHistory = sms;
        callSummaries = calls;
        successFormat = tryPhone;
        break;
      }
    }

    if (!successFormat) {
      console.warn('[openphone-history] No history found for phone in any format. Tried:', phoneFormats.join(', '));
    } else {
      console.log('[openphone-history] phone format that worked:', successFormat, 'sms=' + smsHistory.length, 'calls=' + callSummaries.length);
    }

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
