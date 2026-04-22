/**
 * Webhook Idempotency Utility
 * Prevents duplicate webhook processing by tracking processed webhook IDs
 */

const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';

async function supabaseQuery(query, method = 'GET', body = null, supabaseKey) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1${query}`, options);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase query failed: ${response.status} - ${errorText}`);
  }

  return response;
}

/**
 * Check if a webhook has already been processed
 * @param {string} externalId - The webhook ID from the provider (Stripe event_id, OpenPhone message_id, etc)
 * @param {string} provider - The provider name ('stripe', 'openphone')
 * @param {string} supabaseKey - Supabase API key
 * @returns {Promise<boolean>} - True if already processed, false otherwise
 */
export async function isWebhookProcessed(externalId, provider, supabaseKey) {
  try {
    const response = await supabaseQuery(
      `/webhook_events?external_id=eq.${encodeURIComponent(externalId)}&provider=eq.${encodeURIComponent(provider)}&select=id`,
      'GET',
      null,
      supabaseKey
    );

    const data = await response.json();
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.error('[webhook-idempotency] Error checking webhook:', err.message);
    // If we can't check, fail safely - don't process it
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
 * @returns {Promise<object>} - The recorded webhook event
 */
export async function recordWebhook(externalId, provider, eventType, payload, supabaseKey) {
  try {
    const response = await supabaseQuery(
      '/webhook_events',
      'POST',
      {
        external_id: externalId,
        provider: provider,
        event_type: eventType,
        payload: payload,
        status: 'processed',
        processed_at: new Date().toISOString()
      },
      supabaseKey
    );

    const data = await response.json();
    return data;
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
    // Check if already processed
    const alreadyProcessed = await isWebhookProcessed(externalId, provider, supabaseKey);

    if (alreadyProcessed) {
      console.log(`[webhook-idempotency] Webhook already processed: ${provider}/${externalId}`);
      return {
        alreadyProcessed: true,
        skipped: true,
        result: null
      };
    }

    // Record it first (to prevent race conditions)
    await recordWebhook(externalId, provider, eventType, payload, supabaseKey);

    // Then execute the handler
    const result = await handler();

    return {
      alreadyProcessed: false,
      skipped: false,
      result
    };
  } catch (err) {
    console.error('[webhook-idempotency] Error in processWebhookIdempotently:', err.message);
    throw err;
  }
}
