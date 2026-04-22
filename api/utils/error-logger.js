/**
 * Centralized Error Logger
 * Writes errors to Supabase error_logs table so you can see what breaks
 * without digging through Vercel logs
 */

const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';

/**
 * Log an error to Supabase error_logs table
 * Safe to call — never throws, never breaks the caller
 * 
 * @param {string} source - Which file/function errored (e.g., 'send-sms', 'ai-summary')
 * @param {Error|string} error - The error object or message
 * @param {object} context - Any extra info to store (request body, IDs, etc.)
 * @param {string} supabaseKey - Supabase API key
 */
export async function logError(source, error, context = {}, supabaseKey) {
  const key = supabaseKey || process.env.SUPABASE_ANON_KEY;

  const payload = {
    source,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
    context: context || {},
    occurred_at: new Date().toISOString(),
    resolved: false
  };

  // Always log to console too
  console.error(`[${source}] ${payload.message}`, context);

  // Try to write to Supabase — but never let this fail the caller
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/error_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(payload)
    });
  } catch (loggingErr) {
    // If logging itself fails, just console it — don't throw
    console.error('[error-logger] Failed to write to Supabase:', loggingErr.message);
  }
}

/**
 * Wrap an async function with error logging
 * If the function throws, logs the error and rethrows
 * 
 * @param {string} source - Source label for the log
 * @param {function} fn - Async function to execute
 * @param {object} context - Context to include in error log
 * @param {string} supabaseKey - Supabase API key
 */
export async function withErrorLogging(source, fn, context = {}, supabaseKey) {
  try {
    return await fn();
  } catch (err) {
    await logError(source, err, context, supabaseKey);
    throw err; // Rethrow so caller can handle it
  }
}
