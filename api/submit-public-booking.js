// /api/submit-public-booking
//
// Public endpoint used by book.html when the user submits a booking through
// the no-token public flow. Two branches:
//
//   1. path='new_quote'        — cold lead OR returning customer who chose
//                                 to quote a NEW property. We call
//                                 /api/calculate-quote to compute the price,
//                                 then create (or update) a lead row.
//
//   2. path='existing_property' — returning customer booked at an address
//                                 they've used before. We DON'T create a
//                                 lead; the existing client is matched by
//                                 clientId. The price comes from their last
//                                 paid/completed appointment on record.
//
// Either path then creates a `review_public_booking` task with ALL the
// booking details in `extracted_data`. Dane reviews the task, assigns a
// cleaner, and confirms — that's where the actual appointment gets created
// (separate flow in the in-app task UI). This keeps the calendar clean and
// matches the existing review_call_lead pattern Dane already uses.
//
// Notifications (best-effort, non-blocking):
//   - In-app notification (event_type=lead_inquiry-style for the bell)
//   - Push to all subscribed devices
//   - Email to OWNER_EMAIL
//   - OpenPhone contact creation (dedupes by phone)

import { createClient } from '@supabase/supabase-js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const BASE_URL = 'https://hnc-crm.vercel.app';
const OWNER_EMAIL = 'dane@hawaiinaturalclean.net';
const TAX_RATE = 0.04712;

const db = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function last10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function toE164(phone) {
  // Robust normalization: strip everything to digits, drop a leading '1'
  // if present (US country code), then take last 10. This handles all the
  // ways a customer might type their number ("808-555-1234", "1 808 555
  // 1234", "+1 (808) 555-1234", "18085551234", etc.) and produces a
  // canonical "+1XXXXXXXXXX". Existing callers in the codebase use a
  // simpler `'+1' + digits` pattern that breaks on 11-digit input.
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(-10);
  return '+1' + digits;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── 1. Validate ──────────────────────────────────────────────────────────
  const invalid = validateOrFail(req.body, SCHEMAS.publicBookingSubmit);
  if (invalid) return res.status(400).json(invalid);

  const supabase = db();
  const b = req.body;
  const cleanName = String(b.name).trim();
  const cleanEmail = String(b.email).trim().toLowerCase();
  const cleanPhoneDigits = String(b.phone).replace(/\D/g, '');
  const phone10 = last10(b.phone);
  const e164 = toE164(b.phone);
  const firstName = cleanName.split(/\s+/)[0] || cleanName;

  try {
    const rushFee = (typeof b.rushFee === 'number' || (b.rushFee != null && !isNaN(Number(b.rushFee)))) ? Math.max(0, Number(b.rushFee)) : 0;

    // ── 2. Resolve quote (price + duration) ───────────────────────────────
    // For 'new_quote' we recompute server-side via /api/calculate-quote.
    // Never trust client-supplied price.
    let quoteResult = null;       // calculate-quote response (subtotal/discount/total/duration_minutes)
    let preTaxTotal = null;        // pre-tax pre-rush price (number) — for review task
    let computedTax = null;
    let displayTotal = null;       // total inc. tax + rush (number) for review task summary

    if (b.path === 'new_quote') {
      const calcRes = await fetchWithTimeout(`${BASE_URL}/api/calculate-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceType: b.service,
          beds:        b.beds,
          baths:       b.baths,
          sqft:        b.sqft,
          condition:   b.condition,
          frequency:   b.frequency,
        }),
      }, TIMEOUTS.SUPABASE);
      const calcJson = await calcRes.json();
      if (!calcRes.ok || calcJson.error) {
        return res.status(400).json({ error: calcJson.error || 'Could not compute a quote for these inputs' });
      }
      quoteResult = calcJson;
      if (!calcJson.custom_quote && calcJson.total != null) {
        preTaxTotal = Number(calcJson.total);
        computedTax = +(preTaxTotal * TAX_RATE).toFixed(2);
        displayTotal = +(preTaxTotal + computedTax + rushFee).toFixed(2);
      }
    } else {
      // existing_property: price comes from the client request body
      // (frontend pulled it from the lookup response's lastAppt). We accept
      // it as-is for the review task display only — Dane confirms the final
      // number when he reviews.
      const candidatePrice = b.priceTotal != null ? Number(b.priceTotal) : null;
      if (candidatePrice && !isNaN(candidatePrice)) {
        // Price from lastAppt total_price is post-tax (no rush in the
        // historical price). Pull back into pre-tax for storage; rush gets
        // added on top for the displayed total.
        const histPostTax = +candidatePrice.toFixed(2);
        preTaxTotal = +(histPostTax / (1 + TAX_RATE)).toFixed(2);
        computedTax = +(histPostTax - preTaxTotal).toFixed(2);
        displayTotal = +(histPostTax + rushFee).toFixed(2);
      }
    }

    // ── 3. Find or create lead ─────────────────────────────────────────────
    // We always want a lead row for new_quote (so the lead pipeline picks it
    // up). For existing_property we skip — the user already has a client row,
    // and creating a residual lead clutters the pipeline.
    let leadId = null;
    let leadIsNew = false;

    if (b.path === 'new_quote') {
      // Try to match an existing open lead by email or phone (last 10).
      const { data: existingByEmail } = await supabase
        .from('leads')
        .select('id,stage,booking_token')
        .ilike('email', cleanEmail)
        .order('created_at', { ascending: false })
        .limit(5);

      const { data: existingByPhone } = await supabase
        .from('leads')
        .select('id,stage,booking_token,phone,email')
        .ilike('phone', '%' + phone10)
        .order('created_at', { ascending: false })
        .limit(5);

      const allCandidates = [...(existingByEmail || []), ...(existingByPhone || [])];
      const open = allCandidates.find((l) => l.stage !== 'Closed lost' && l.stage !== 'Closed won');

      if (open) {
        leadId = open.id;
        // Update the open lead with the latest quote info — they're requesting
        // a new quote so the freshest numbers should land on the row.
        const noteParts = [
          'Service: '   + b.service,
          b.island     ? 'Island: '    + b.island    : null,
          b.frequency  ? 'Frequency: ' + b.frequency : null,
          b.beds       ? 'Beds: '      + b.beds      : null,
          b.baths      ? 'Baths: '     + b.baths     : null,
          b.sqft       ? 'Sqft: '      + b.sqft      : null,
          b.condition  ? 'Condition: ' + b.condition + '/10' : null,
          'Submitted via public booking form on ' + new Date().toISOString().slice(0, 10),
        ].filter(Boolean).join('\n');

        const upd = { service: b.service, address: b.address, notes: noteParts };
        if (quoteResult && !quoteResult.custom_quote && quoteResult.total != null) {
          upd.quote_total = quoteResult.total;
          upd.quote_data = quoteResult;
          upd.quote_sent_at = new Date().toISOString();
          upd.stage = 'Quoted';
        }
        if (b.sqft) upd.sqft = parseInt(b.sqft) || null;
        const { error: updErr } = await supabase.from('leads').update(upd).eq('id', leadId);
        if (updErr) {
          // Non-fatal — task creation below is the critical path. Log so we
          // can spot stale-lead-info issues later without failing the booking.
          await logError('submit-public-booking:lead-update', updErr, { leadId, email: cleanEmail });
        }
      } else {
        // Create a new lead — mirrors lead-capture.js shape.
        leadIsNew = true;
        const bookingToken = crypto.randomUUID();
        const noteParts = [
          'Service: '   + b.service,
          b.island     ? 'Island: '    + b.island    : null,
          b.frequency  ? 'Frequency: ' + b.frequency : null,
          b.beds       ? 'Beds: '      + b.beds      : null,
          b.baths      ? 'Baths: '     + b.baths     : null,
          b.sqft       ? 'Sqft: '      + b.sqft      : null,
          b.condition  ? 'Condition: ' + b.condition + '/10' : null,
          'Submitted via public booking form',
        ].filter(Boolean).join('\n');

        const insertPayload = {
          name:             cleanName,
          contact_name:     cleanName,
          email:            cleanEmail,
          phone:            cleanPhoneDigits,
          address:          b.address.trim(),
          service:          b.service,
          sqft:             b.sqft ? parseInt(b.sqft) : null,
          source:           'Public booking form',
          stage:            quoteResult && !quoteResult.custom_quote ? 'Quoted' : 'New inquiry',
          segment:          'public_booking_pending',
          segment_moved_at: new Date().toISOString(),
          assigned_to:      'VA',
          booking_token:    bookingToken,
          notes:            noteParts,
        };
        if (quoteResult && !quoteResult.custom_quote && quoteResult.total != null) {
          insertPayload.quote_total   = quoteResult.total;
          insertPayload.quote_data    = quoteResult;
          insertPayload.quote_sent_at = new Date().toISOString();
        }

        const { data: insertData, error: insertErr } = await supabase
          .from('leads')
          .insert([insertPayload])
          .select('id');
        if (insertErr) {
          await logError('submit-public-booking:lead-insert', insertErr, { email: cleanEmail });
          return res.status(500).json({ error: 'Could not save your request. Please call (808) 468-5356.' });
        }
        leadId = insertData[0].id;
      }
    }

    // ── 4. Create review task ──────────────────────────────────────────────
    const taskTitle = (b.path === 'existing_property' ? 'Booking — returning client: ' : 'Booking — new lead: ') + cleanName;
    const summaryLine = b.service + (b.frequency ? ' · ' + b.frequency : '') +
      (displayTotal != null ? ' · $' + displayTotal.toFixed(2) : '');
    const description = [
      'Public booking request submitted via book.html',
      '',
      'Customer: ' + cleanName,
      'Phone:    ' + cleanPhoneDigits,
      'Email:    ' + cleanEmail,
      'Address:  ' + b.address + (b.island ? ' (' + b.island + ')' : ''),
      '',
      'Service:   ' + b.service + (b.frequency ? ' (' + b.frequency + ')' : ''),
      b.beds       ? 'Beds:      ' + b.beds       : null,
      b.baths      ? 'Baths:     ' + b.baths      : null,
      b.sqft       ? 'Sqft:      ' + b.sqft       : null,
      b.condition  ? 'Condition: ' + b.condition + '/10' : null,
      '',
      'Requested: ' + b.date + ' at ' + b.time,
      rushFee > 0 ? 'Rush fee:  $' + rushFee.toFixed(2) + ' (' + (rushFee === 200 ? 'same-day' : rushFee === 100 ? 'next-day' : '2-day') + ')' : null,
      displayTotal != null ? 'Quote:     $' + displayTotal.toFixed(2) + ' (incl. tax' + (rushFee > 0 ? ' + rush' : '') + ')' : 'Quote:     custom',
      '',
      b.notes ? 'Customer notes: ' + b.notes : null,
      '',
      b.path === 'existing_property'
        ? 'Path: returning client (existing property) — clientId ' + (b.clientId || 'unknown')
        : (leadIsNew ? 'Path: new cold lead — leadId ' + leadId : 'Path: returning lead — leadId ' + leadId),
    ].filter((x) => x !== null).join('\n');

    const today = new Date().toISOString().split('T')[0];
    // Pretty date for notifications (e.g. "Wed May 7 at 9:00 AM")
    let prettyReq = b.date + ' at ' + b.time;
    try {
      const _d = new Date(b.date + 'T12:00:00');
      const _wd = _d.toLocaleDateString('en-US', { weekday: 'short' });
      const _md = _d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      prettyReq = _wd + ' ' + _md + ' at ' + b.time;
    } catch (_e) { /* fall back to ISO format */ }
    const rushTag = rushFee > 0 ? ' \u26A1 ' + (rushFee === 200 ? 'SAME-DAY' : rushFee === 100 ? 'NEXT-DAY' : '2-DAY') : '';

    const taskRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/tasks`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        title:       taskTitle,
        type:        'review_public_booking',
        priority:    'high',
        due_date:    today,
        description: description,
        status:      'open',
        extracted_data: {
          path:           b.path,
          name:           cleanName,
          email:          cleanEmail,
          phone:          cleanPhoneDigits,
          address:        b.address,
          island:         b.island || null,
          service:        b.service,
          frequency:      b.frequency || null,
          beds:           b.beds || null,
          baths:          b.baths || null,
          sqft:           b.sqft || null,
          condition:      b.condition || null,
          requested_date: b.date,
          requested_time: b.time,
          customer_notes: b.notes || null,
          quote_total_pretax:    preTaxTotal,
          quote_tax:             computedTax,
          rush_fee:              rushFee,
          quote_total_with_tax:  displayTotal,
          quote_data:            quoteResult || null,
          lead_id:               leadId,
          client_id:             b.clientId || null,
          property_address:      b.propertyAddress || null,
          source:                'Public booking form',
          submitted_at:          new Date().toISOString(),
        },
      }),
    });

    if (!taskRes.ok) {
      const errBody = await taskRes.text().catch(() => '<unreadable>');
      await logError('submit-public-booking:task-insert', new Error('Task insert ' + taskRes.status), {
        body: errBody.slice(0, 500), email: cleanEmail,
      });
      return res.status(500).json({ error: 'Could not save your request. Please call (808) 468-5356.' });
    }

    // Capture the new task's id so the notification can deep-link the admin
    // straight into the review modal (otherwise lead_inquiry routes to the
    // lead profile, which only has a generic "Book appointment" button).
    let taskRowId = null;
    try {
      const taskRows = await taskRes.json();
      if (Array.isArray(taskRows) && taskRows[0] && taskRows[0].id) taskRowId = taskRows[0].id;
    } catch (_e) { /* non-fatal */ }

    // ── 5. Best-effort: OpenPhone contact (dedupes naturally by phone) ──────
    if (b.path === 'new_quote' && leadIsNew) {
      fetchWithTimeout(`${BASE_URL}/api/openphone-create-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, phone: e164, email: cleanEmail, leadId }),
      }, TIMEOUTS.OPENPHONE).catch((err) => {
        // OpenPhone failure is non-fatal — task is already saved
        logError('submit-public-booking:openphone-contact', err, { leadId, phone: e164 });
      });
    }

    // ── 6. Best-effort: in-app notification (the bell) ─────────────────────
    fetch(`${process.env.SUPABASE_URL}/rest/v1/notifications`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        event_type: 'lead_inquiry',
        title: 'New booking request: ' + cleanName + rushTag,
        body: prettyReq + ' \u00b7 ' + b.service + (b.frequency ? ' (' + b.frequency + ')' : '') + (displayTotal != null ? ' \u00b7 $' + displayTotal.toFixed(2) : ''),
        url: '/#tasks',
        metadata: { source: 'public_booking', taskId: taskRowId, leadId, clientId: b.clientId || null, name: cleanName, phone: cleanPhoneDigits, service: b.service, path: b.path, requestedDate: b.date, requestedTime: b.time, rushFee: rushFee },
      }),
    }).catch((err) => console.warn('[submit-public-booking] in-app notify failed:', err && err.message));

    // ── 7. Best-effort: push fan-out ───────────────────────────────────────
    import('./utils/send-push.js').then(({ sendPushToAllSubscribed }) => {
      return sendPushToAllSubscribed({
        title: 'Booking request \u2014 ' + cleanName + rushTag,
        body: prettyReq + ' \u00b7 ' + b.service + (displayTotal != null ? ' \u00b7 $' + displayTotal.toFixed(2) : ''),
        url: '/#tasks',
        tag: 'public-booking-' + (leadId || b.clientId || phone10),
        urgency: 'high',
      });
    }).catch((err) => console.warn('[submit-public-booking] push notify failed:', err && err.message));

    // ── 8. Best-effort: owner email ────────────────────────────────────────
    fetchWithTimeout(`${BASE_URL}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: OWNER_EMAIL,
        subject: 'New booking request: ' + cleanName + ' — ' + b.service,
        type: 'generic',
        clientName: 'Dane',
        notes: description + '\n\nReview in CRM: https://hnc-crm.vercel.app/#tasks',
      }),
    }, TIMEOUTS.RESEND).catch((err) => {
      logError('submit-public-booking:owner-email', err, { leadId });
    });

    // ── 9. Done ────────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'Booking request received. We\'ll confirm within 24 hours.',
      leadId,
      requestedDate: b.date,
      requestedTime: b.time,
    });

  } catch (err) {
    await logError('submit-public-booking', err, { email: cleanEmail, path: b.path });
    return res.status(500).json({ error: 'Could not save your request. Please call (808) 468-5356.', detail: err.message });
  }
}
