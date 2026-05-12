// /api/resend-webhook
//
// Receives Resend email lifecycle events and updates the matching
// activity_logs row so async bounces / complaints surface in the
// Activity feed and on Dane's bell + phone.
//
// Why this exists: Resend's POST /emails returns 200 the moment the
// email is queued — that doesn't mean it'll be delivered. DNS
// failures, dead mailboxes, spam complaints, etc. all happen later
// at the SMTP layer. Without this webhook, those failures vanish.
//
// Confirmed via real test 2026-05-11: Dane sent to dane.kreisman@gmail.comm
// (typo). Resend returned 200, activity_log written with status='success',
// no failure surfaced. The actual bounce happens minutes later but never
// reached our system. This endpoint fixes that.
//
// Resend events we care about (from https://resend.com/docs/dashboard/webhooks/event-types):
//
//   email.sent           queued for delivery (we already log this on POST)
//   email.delivered      reached the recipient mail server — success
//   email.delivery_delayed  retrying, not a final state
//   email.bounced        permanent failure (bad address, blocked, etc.)
//   email.complained     marked as spam by recipient
//   email.opened         tracking pixel hit (noise, don't update logs)
//   email.clicked        link click (noise, don't update logs)
//
// We update activity_logs on bounced/complained → status='failed' with a
// human-readable reason → triggers bell + push notification via the same
// helper Phase 1a uses.
//
// Setup in Resend dashboard: point a webhook at
//   https://book.hawaiinaturalclean.com/api/resend-webhook
// with the events 'email.bounced' and 'email.complained' enabled (others
// can be enabled too; this handler ignores them).
//
// Optional but recommended: set RESEND_WEBHOOK_SECRET env var. When set,
// this handler verifies the svix signature header to prevent forged
// events. Without the secret it accepts any POST — fine for dev but
// production should set it.

import { logError } from './utils/error-logger.js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Parse body. Vercel auto-parses JSON for application/json content-type.
  const body = req.body || {};
  const eventType = body.type || '';
  const data = body.data || {};

  // Only act on terminal failure events. Successful delivery events are
  // ignored — we already logged success at send time. Opens/clicks are
  // noise that would create churn in the activity feed.
  const isFailure = eventType === 'email.bounced' || eventType === 'email.complained';
  if (!isFailure) {
    return res.status(200).json({ ok: true, ignored: eventType });
  }

  // Resend event payloads include the email_id under data.email_id (or
  // sometimes data.id depending on event shape). We logged it as
  // metadata.resend_id at send time.
  const resendId = data.email_id || data.id || null;
  if (!resendId) {
    await logError('resend-webhook', 'event missing email_id', { event_type: eventType, body });
    return res.status(400).json({ error: 'missing_email_id' });
  }

  // Look up the activity_log row that was written when this email was
  // queued. Filter by metadata->>resend_id. Postgres JSONB filter syntax
  // via PostgREST: `metadata->>resend_id=eq.<id>`. We grab the most
  // recent match in case the same resend_id ever shows up twice
  // (shouldn't, but defensive).
  let logRow = null;
  try {
    const lookupRes = await fetch(
      `${SB_URL}/rest/v1/activity_logs?metadata->>resend_id=eq.${encodeURIComponent(resendId)}&order=created_at.desc&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } }
    );
    const rows = await lookupRes.json();
    if (Array.isArray(rows) && rows.length > 0) logRow = rows[0];
  } catch (e) {
    await logError('resend-webhook:lookup', e, { resend_id: resendId, event_type: eventType });
    return res.status(500).json({ error: 'lookup_failed' });
  }

  if (!logRow) {
    // No matching log. Could be: email sent before this webhook existed,
    // or sent from a code path that doesn't log resend_id yet (most
    // email senders besides manual-send-confirmation). Log a Recent
    // Errors entry so Dane knows this bounce happened even if we can't
    // attach it to a specific log row.
    await logError('resend-webhook', 'bounce/complaint for unknown email — no matching activity_log row', {
      resend_id: resendId,
      event_type: eventType,
      bounce: data.bounce || null,
      complaint: data.complaint || null,
      to: data.to || null,
    });
    return res.status(200).json({ ok: true, matched: false });
  }

  // Build a user-readable failure reason from the event payload. Bounce
  // payloads include type ('hard'|'soft') and a message string from the
  // receiving mail server. Complaints don't include much detail beyond
  // the type.
  let failure_reason;
  if (eventType === 'email.bounced') {
    const bounceType = data.bounce?.type || 'unknown';
    const bounceMsg  = data.bounce?.message || data.bounce?.subType || '';
    // Most common bounce: 'hard' bounce due to bad address/domain.
    // Render this in Dane's terms.
    if (bounceType === 'hard') {
      failure_reason = bounceMsg
        ? 'Email bounced: ' + bounceMsg.slice(0, 200)
        : 'Email bounced — recipient address invalid or domain doesn\'t exist';
    } else {
      failure_reason = 'Email delivery failed (' + bounceType + ')' + (bounceMsg ? ': ' + bounceMsg.slice(0, 200) : '');
    }
  } else {
    // complained
    failure_reason = 'Recipient marked the email as spam';
  }

  // Update the activity log row: status='failed', failure_reason set,
  // plus a flag tracking which event triggered the update for audit.
  const newMetadata = {
    ...(logRow.metadata || {}),
    status: 'failed',
    failure_reason,
    resend_event: eventType,
    resend_event_at: new Date().toISOString(),
  };

  try {
    await fetch(`${SB_URL}/rest/v1/activity_logs?id=eq.${logRow.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ metadata: newMetadata }),
    });
  } catch (e) {
    await logError('resend-webhook:update', e, { resend_id: resendId, log_id: logRow.id });
    return res.status(500).json({ error: 'update_failed' });
  }

  // Fire bell + push notification — same helpers Phase 1a's logActivity
  // uses on failed paths. Inlined here rather than calling logActivity
  // (which would create a NEW log row) so we don't duplicate the row.
  await fireFailureNotifications(logRow.action, logRow.description, newMetadata, failure_reason);

  return res.status(200).json({ ok: true, matched: true, log_id: logRow.id });
}

// Mirror of the helper inside log-activity.js. Duplicated here since
// importing from log-activity would also pull in the logActivity export
// which we don't want (no NEW row needed — we just patched the existing
// one). Worth extracting to a shared util in a future cleanup.
async function fireFailureNotifications(action, description, meta, failure_reason) {
  const title = '\u26A0\uFE0F ' + humanizeAction(action) + ' bounced';
  const body = (description ? description + ' \u2014 ' : '') + (failure_reason || 'See Recent Errors for details');
  let url = '/';
  if (meta.client_id) url = '/?client=' + meta.client_id;
  else if (meta.lead_id) url = '/?lead=' + meta.lead_id;
  else if (meta.cleaner_id) url = '/?cleaner=' + meta.cleaner_id;
  else if (meta.appointmentId) url = '/?appt=' + meta.appointmentId;
  else if (meta.appointment_id) url = '/?appt=' + meta.appointment_id;

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
    try { await logError('resend-webhook:bell-notify', e, { action }); } catch (_) {}
  }

  try {
    const { sendPushToAllSubscribed } = await import('./utils/send-push.js');
    await sendPushToAllSubscribed({ title, body, url });
  } catch (e) {
    try { await logError('resend-webhook:push', e, { action }); } catch (_) {}
  }
}

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
    email_sent_booking_confirmation: 'Confirmation email',
    email_sent_appointment_reminder: 'Reminder email',
    email_sent_invoice: 'Invoice email',
    email_sent_review_request: 'Review request email',
    email_sent_generic: 'Email',
  };
  return map[action] || action.replace(/_/g, ' ');
}
