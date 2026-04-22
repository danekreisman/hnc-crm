/**
 * Webhook Idempotency Utility
 * Prevents duplicate webhook processing by tracking processed webhook IDs
 */

const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';

/**
 * Check if a webhook has already been processed
 * @param {string} externalId - The webhook ID from the provider
 * @param {string} provider - The provider name ('stripe', 'openphone')
 * @param {string} supabaseKey - Supabase API key
 * @returns {Promise<boolean>} - True if already processed, false otherwise
 */
export async function isWebhookProcessed(externalId, provider, supabaseKey) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/webhook_events?external_id=eq.${encodeURIComponent(externalId)}&provider=eq.${encodeURIComponent(provider)}&select=id`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase query failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.error('[webhook-idempotency] Error checking webhook:', err.message);
    throw err;
  }
}

/**
 * Record a webhook as processed
 * @param {string} externalId - The webhook ID from the provider
 * @param {string} provider - The provider name
 * @param {string} eventType - Event type (e.g., 'message.received', 'payment_intent.succeeded')
 * @param {object} payload - Full webhook payload (stored for debugging)
 * @param {string} supabaseKey - Supabase API key
 * @returns {Promise<boolean>} - True if recorded successfully
 */
export async function recordWebhook(externalId, provider, eventType, payload, supabaseKey) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/webhook_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        external_id: externalId,
        provider: provider,
        event_type: eventType,
        payload: payload,
        status: 'processed',
        processed_at: new Date().toISOString()
      })
    });

    if (response.status === 409) {
      // Duplicate key — race condition, another process already recorded this
      console.log(`[webhook-idempotency] Duplicate webhook caught by DB constraint: ${externalId}`);
      return false;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to record webhook: ${response.status} - ${errorText}`);
    }

    return true;
  } catch (err) {
    console.error('[webhook-idempotency] Error recording webhook:', err.message);
    throw err;
  }
}

/**
 * Idempotent webhook handler wrapper
 * Checks if webhook was already processed, records it, then calls handler
 * @param {string} externalId - Webhook ID from provider
 * @param {string} provider - Provider name
 * @param {string} eventType - Event type
 * @param {object} payload - Full webhook payload
 * @param {function} handler - Async function to call if webhook is new
 * @param {string} supabaseKey - Supabase API key
 * @returns {Promise<object>} - Result object with alreadyProcessed flag and handler result
 */
export async function processWebhookIdempotently(
  externalId,
  provider,
  eventType,
  payload,
  handler,
  supabaseKey
) {
  try {
    const alreadyProcessed = await isWebhookProcessed(externalId, provider, supabaseKey);

    if (alreadyProcessed) {
      console.log(`[webhook-idempotency] Webhook already processed: ${provider}/${externalId}`);
      return { alreadyProcessed: true, skipped: true, result: null };
    }

    // Record first to prevent race conditions
    await recordWebhook(externalId, provider, eventType, payload, supabaseKey);

    const result = await handler();

    return { alreadyProcessed: false, skipped: false, result };
  } catch (err) {
    console.error('[webhook-idempotency] Error in processWebhookIdempotently:', err.message);
    throw err;
  }
}
