/**
 * Timeout wrapper for external API calls
 * Prevents a slow/hung external service from freezing your entire function
 */

/**
 * Race a promise against a timeout
 * 
 * @param {Promise} promise - The async operation to run
 * @param {number} ms - Timeout in milliseconds (default: 8000ms / 8 seconds)
 * @param {string} label - Label for the timeout error message
 * @returns {Promise} - Resolves with promise result or rejects with timeout error
 */
export function withTimeout(promise, ms = 8000, label = 'Operation') {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * fetch() with a built-in timeout
 * Drop-in replacement for fetch() when calling external APIs
 * 
 * @param {string} url - URL to fetch
 * @param {object} options - Standard fetch options
 * @param {number} ms - Timeout in milliseconds (default: 8000ms)
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(url, options = {}, ms = 8000) {
  const label = `fetch(${url.split('?')[0]})`; // Strip query params from label
  return withTimeout(fetch(url, options), ms, label);
}

// Preset timeouts for specific services based on their typical response times
export const TIMEOUTS = {
  SUPABASE: 5000,      // Supabase queries should be fast
  ANTHROPIC: 15000,    // AI can take longer — give it 15s
  STRIPE: 10000,       // Stripe is usually fast but give some headroom
  OPENPHONE: 8000,     // OpenPhone SMS
  RESEND: 8000,        // Resend email
};
