// Shared activity-log helper.
//
// Background (2026-05-11 design call with Dane): the Activity section
// on each client / lead / cleaner profile reads from `activity_logs`
// filtered by entity ID. Every site that fires a user-meaningful action
// must log here with consistent metadata so the renderer can filter
// reliably and the detail modal can show full context without each
// renderer needing custom code per action type.
//
// Required fields per call:
//   action       — short snake_case identifier (e.g. 'manual_waiver_sent',
//                  'stripe_charge_succeeded', 'cleaner_invite_auto_assigned')
//   description  — short human-readable line for the feed row. Already
//                  rendered (no template). Example: "Waiver reminder
//                  sent to Sarah Kim". Avoid technical jargon — Dane
//                  reads these directly.
//   metadata     — object. MUST include at least one of:
//                    client_id   — for client-scoped Activity views
//                    lead_id     — for lead-scoped Activity views
//                    cleaner_id  — for cleaner-scoped Activity views
//                  Plus anything the detail modal will want to show:
//                    recipient, body, appointment_id, payment_intent_id,
//                    amount, success/failure indicators, etc.
//
// Optional fields:
//   user_email   — who fired the action. Falls back to 'system' for
//                  cron-driven actions. Set explicitly for manual sends
//                  to attribute correctly in the feed.
//   status       — 'success' (default) or 'failed'. When 'failed', the
//                  helper also fires a bell notification + push so Dane
//                  knows something needs attention.
//   failure_reason — user-readable reason for the failure. Shown in the
//                    bell notification and in the Activity row's red-tint
//                    state. Example: "Phone number invalid", "Card
//                    declined", "OpenPhone API error 502".
//
// Non-blocking: errors writing to activity_logs are caught and logged
// to console; we never want a logging failure to break the caller's
// main operation. Same for notifications.

import { logError } from './error-logger.js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function logActivity(action, description, metadata = {}, opts = {}) {
  const user_email = opts.user_email || 'system';
  const status = opts.status || 'success';
  const failure_reason = opts.failure_reason || null;

  // The status + failure_reason live inside metadata for back-compat with
  // the existing schema (no new columns required). The renderer reads
  // metadata.status to tint failed rows and metadata.failure_reason for
  // the inline error label.
  const meta = { ...metadata, status };
  if (failure_reason) meta.failure_reason = failure_reason;

  try {
    await fetch(SB_URL + '/rest/v1/activity_logs', {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        action,
        description,
        user_email,
        entity_type: action, // legacy field; kept for back-compat
        metadata: meta,
      }),
    });
  } catch (e) {
    // Non-blocking — don't bubble. Surface to logError so we can audit
    // logging gaps without breaking the caller.
    try { await logError('log-activity', e, { action, description }); } catch (_) {}
  }

  // Failure side-effects: bell notification + push to all subscribed
  // devices. Dane's framing: "How else am I supposed to know that a
  // text did not send or a card got declined?" Push is the
  // authoritative offline channel.
  if (status === 'failed') {
    await fireFailureNotifications(action, description, meta, failure_reason);
  }
}

// fireFailureNotifications — bell row + push.
//
// Bell uses the existing notifications table that powers the dropdown.
// Push uses the existing sendPushToAllSubscribed helper.
//
// Title format: "⚠️ <short action label> failed"
// Body: "<recipient if known>: <failure_reason>"
// URL: deep-link to the entity (client/lead/cleaner) if we have an ID.
async function fireFailureNotifications(action, description, meta, failure_reason) {
  const title = '⚠️ ' + humanizeAction(action) + ' failed';
  const body = (description ? description + ' — ' : '') + (failure_reason || 'See Recent Errors for details');
  let url = '/';
  if (meta.client_id) url = '/?client=' + meta.client_id;
  else if (meta.lead_id) url = '/?lead=' + meta.lead_id;
  else if (meta.cleaner_id) url = '/?cleaner=' + meta.cleaner_id;
  else if (meta.appointment_id) url = '/?appt=' + meta.appointment_id;

  // Bell notification — written by the same shape used elsewhere
  // (api/lead-capture.js, api/stripe-webhook.js, etc.).
  try {
    await fetch(SB_URL + '/rest/v1/notifications', {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        event_type: 'failure_' + action,
        title,
        body,
        url,
        metadata: meta,
      }),
    });
  } catch (e) {
    try { await logError('log-activity:bell-notify', e, { action }); } catch (_) {}
  }

  // Push notification — fire-and-forget, same as lead-capture pattern.
  try {
    const { sendPushToAllSubscribed } = await import('./send-push.js');
    await sendPushToAllSubscribed({ title, body, url });
  } catch (e) {
    try { await logError('log-activity:push', e, { action }); } catch (_) {}
  }
}

// humanizeAction — turn snake_case action names into readable labels
// for notification titles. Adds new types here as we log new actions.
function humanizeAction(action) {
  const map = {
    manual_confirmation_sent: 'Confirmation email',
    manual_reminder_sent: 'Reminder SMS',
    manual_waiver_sent: 'Waiver SMS',
    manual_cleaner_job_sent: 'Cleaner job SMS',
    manual_reschedule_sent: 'Reschedule notification',
    manual_invoice_email_sent: 'Invoice email',
    manual_invoice_sms_sent: 'Invoice SMS',
    manual_review_email_sent: 'Review request email',
    manual_review_sms_sent: 'Review request SMS',
    manual_charge_followup_sent: 'Charge follow-up SMS',
    manual_resend_booking_link: 'Booking link resend',
    stripe_charge_succeeded: 'Card charge',
    stripe_charge_failed: 'Card charge',
    cleaner_invite_sent: 'Cleaner invite SMS',
    cleaner_invite_auto_assigned: 'Auto-assign',
    cards_synced: 'Card sync',
    policy_agreed: 'Policy signature',
    lead_to_client_converted: 'Lead conversion',
    gcal_event_upserted: 'Google Calendar sync',
  };
  return map[action] || action.replace(/_/g, ' ');
}
