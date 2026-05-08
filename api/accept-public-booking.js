// /api/accept-public-booking
//
// Called from the public-booking review modal in the CRM. Dane clicks
// "Accept & Schedule" on a `review_public_booking` task and this endpoint:
//
//   1. Loads the task and reads its extracted_data (the snapshot of what
//      the customer submitted via book.html).
//
//   2. Branches on extracted_data.path:
//      - 'new_quote'        → call book_lead_atomic RPC (creates/finds
//                              client, creates appointment, closes the
//                              lead as 'Closed won'). Same RPC the
//                              token-link auto-book flow uses.
//      - 'existing_property'→ direct INSERT into appointments using the
//                              already-matched client_id from the task.
//                              No lead row is touched.
//
//   3. Marks the task complete (best-effort — if it fails, the appointment
//      still exists; Dane will spot the still-open task and dismiss it
//      manually rather than a duplicate appointment being created).
//
//   4. Optionally sends a confirmation email to the customer (gated by
//      the request body's `sendEmail` flag — default false so accepting
//      during testing doesn't ping real customers).
//
// Returns: { success, appointmentId, clientId, leadId? }
//
// Auth: Bearer token, same pattern as /api/accept-call-lead.

import { createClient } from '@supabase/supabase-js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const BASE_URL = 'https://hnc-crm.vercel.app';
const TAX_RATE = 0.04712;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth gate (same pattern as /api/accept-call-lead) ──────────────────
  const authHdr = req.headers.authorization || '';
  const tokenStr = authHdr.replace('Bearer ', '').trim();
  if (!tokenStr) return res.status(401).json({ error: 'Unauthorized' });
  const authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + tokenStr, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });

  // ── Validate input ─────────────────────────────────────────────────────
  const invalid = validateOrFail(req.body, SCHEMAS.acceptPublicBooking);
  if (invalid) return res.status(400).json(invalid);

  const { taskId, date: dateOverride, time: timeOverride, notes: notesOverride, sendEmail } = req.body;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // ── 1. Load + verify task ────────────────────────────────────────────
    const { data: task, error: taskErr } = await db
      .from('tasks')
      .select('id,type,status,extracted_data')
      .eq('id', taskId)
      .maybeSingle();
    if (taskErr) throw taskErr;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.type !== 'review_public_booking') return res.status(400).json({ error: 'Task is not a review_public_booking' });
    if (task.status !== 'open') return res.status(409).json({ error: 'Task is no longer open (already accepted or dismissed)' });

    const x = task.extracted_data || {};
    const date = (dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) ? dateOverride : x.requested_date;
    const time = timeOverride || x.requested_time;
    if (!date || !time) return res.status(400).json({ error: 'Task is missing requested_date or requested_time' });

    // Edit-mode overrides (Dane clicked Edit in the modal). These let him
    // change service / frequency / beds / baths / sqft / total at acceptance
    // time without round-tripping through the customer. Each falls back to
    // the original extracted value if not provided.
    const service   = (typeof req.body.service === 'string' && req.body.service.trim()) || x.service || 'Regular Cleaning';
    const frequency = req.body.frequency != null ? (req.body.frequency || null) : (x.frequency || null);
    const beds      = req.body.beds       != null ? (req.body.beds      || null) : (x.beds      || null);
    const baths     = req.body.baths      != null ? (req.body.baths     || null) : (x.baths     || null);
    const sqft      = req.body.sqft       != null ? (req.body.sqft      || null) : (x.sqft      || null);

    // Pricing — match the canonical token-flow convention from
    // api/lead-book.js so reports/invoices stay consistent across all
    // booking paths:
    //
    //   base_price  = SUBTOTAL (gross pre-tax pre-discount)
    //   discount    = absolute dollar discount
    //   tax         = (base_price - discount) * TAX_RATE
    //   total_price = base_price - discount + tax + rushFee
    //
    // The earlier draft stored base_price as post-discount net, which
    // would have made reports under-count revenue whenever a frequency
    // discount applied. Caught during May 7 audit.
    const rushFee   = x.rush_fee != null ? Number(x.rush_fee) : 0;
    const discount  = (x.quote_data && x.quote_data.discount != null) ? Number(x.quote_data.discount) : 0;
    const durationHrs = (x.quote_data && x.quote_data.duration_minutes != null) ? +(Number(x.quote_data.duration_minutes) / 60).toFixed(2) : null;

    // Pull subtotal (gross pre-tax) from the original quote. Fall back to
    // pretax + discount if subtotal isn't on the task (existing_property
    // path doesn't have a "subtotal" — historical price is its own truth).
    let baseGross = (x.quote_data && x.quote_data.subtotal != null)
      ? Number(x.quote_data.subtotal)
      : (x.quote_total_pretax != null ? Number(x.quote_total_pretax) + discount : null);
    let netPretax = x.quote_total_pretax != null ? Number(x.quote_total_pretax) : (baseGross != null ? baseGross - discount : null);
    let tax       = x.quote_tax != null ? Number(x.quote_tax) : (netPretax != null ? +(netPretax * TAX_RATE).toFixed(2) : null);
    let totalPost = x.quote_total_with_tax != null ? Number(x.quote_total_with_tax) : null;

    // If Dane edited the total in the modal, treat the new value as
    // authoritative gross. Drop the original discount (it was the formula
    // discount; Dane's overriding the price entirely now). The math:
    //   total = base + tax + rush  →  base = (total - rush) / (1 + TAX_RATE)
    let editedDiscount = discount;
    if (req.body.totalPrice != null && !isNaN(Number(req.body.totalPrice)) && Number(req.body.totalPrice) >= 0) {
      const tp = Number(req.body.totalPrice);
      totalPost = +tp.toFixed(2);
      baseGross = +((tp - rushFee) / (1 + TAX_RATE)).toFixed(2);
      if (baseGross < 0) baseGross = 0;
      netPretax = baseGross;          // edited price absorbs any discount
      editedDiscount = 0;
      tax = +(baseGross * TAX_RATE).toFixed(2);
    }

    const apptNotesParts = [
      'Booked via public form review',
      rushFee > 0 ? `Rush fee: $${rushFee} (${rushFee === 200 ? 'same-day' : rushFee === 100 ? 'next-day' : '2-day'})` : null,
      notesOverride ? `Admin notes: ${notesOverride}` : null,
      x.customer_notes ? `Customer notes: ${x.customer_notes}` : null,
    ].filter(Boolean);
    const apptNotes = apptNotesParts.join('\n');

    // Common appointment payload shape used by both branches below.
    const apptCommon = {
      service:        service,
      frequency:      frequency || null,
      date:           date,
      time:           time,
      address:        x.address || null,
      beds:           beds,
      baths:          baths,
      sqft:           sqft ? String(sqft) : null,
      status:         'scheduled',
      base_price:     baseGross != null ? String(baseGross) : null,
      discount:       String(editedDiscount || 0),
      tax:            tax != null ? String(tax) : null,
      total_price:    totalPost != null ? String(totalPost) : null,
      duration_hours: durationHrs != null ? String(durationHrs) : null,
      notes:          apptNotes,
    };

    let appointmentId = null;
    let clientId = null;
    const leadId = x.lead_id || null;

    // ── 2. Branch on path ────────────────────────────────────────────────
    if (x.path === 'new_quote') {
      // Use the existing atomic RPC. Mirrors the lead-book.js flow.
      // Client record uses the same edit-mode overrides we applied to
      // the appointment so a new client is created with consistent values.
      const { data: bookingResult, error: bookErr } = await db.rpc('book_lead_atomic', {
        p_lead_id:          leadId,
        p_client_data: {
          name:      x.name,
          email:     x.email,
          phone:     x.phone || null,
          address:   x.address || null,
          type:      'Residential',
          service:   service || null,
          frequency: frequency || null,
          beds:      beds || null,
          baths:     baths || null,
          sqft:      sqft ? String(sqft) : null,
          status:    'New',
          notes:     'Created automatically from public booking form review',
        },
        p_appointment_data: apptCommon,
      });
      if (bookErr) {
        await logError('accept-public-booking:rpc', bookErr, { taskId, leadId });
        return res.status(500).json({ error: 'Booking failed — no changes were saved.', detail: bookErr.message });
      }
      clientId = bookingResult.client_id;
      appointmentId = bookingResult.appointment_id;
    } else if (x.path === 'existing_property') {
      // Direct insert against the matched client. No lead to close.
      if (!x.client_id) return res.status(400).json({ error: 'Task is missing client_id for existing_property path' });
      clientId = x.client_id;
      const { data: apptRows, error: apptErr } = await db
        .from('appointments')
        .insert([{ client_id: clientId, ...apptCommon }])
        .select('id');
      if (apptErr) {
        await logError('accept-public-booking:appt-insert', apptErr, { taskId, clientId });
        return res.status(500).json({ error: 'Could not create appointment', detail: apptErr.message });
      }
      appointmentId = apptRows && apptRows[0] && apptRows[0].id;
    } else {
      return res.status(400).json({ error: 'Task has unknown path: ' + (x.path || 'null') });
    }

    // ── 3. Mark task done (non-fatal if it fails) ────────────────────────
    const { error: tUpdErr } = await db
      .from('tasks')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', taskId);
    if (tUpdErr) {
      // Don't fail the whole request — the appointment is real and that's
      // what matters. Log so it can be cleaned up manually.
      await logError('accept-public-booking:task-update', tUpdErr, { taskId, appointmentId });
    }

    // ── 4. Optional: send confirmation email to customer ────────────────
    // Default OFF — keeps testing safe. Frontend opts in explicitly via
    // sendEmail: true in the request body.
    if (sendEmail === true && x.email) {
      let prettyDate = date;
      try { prettyDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); } catch (_e) {}
      const totalLine = totalPost != null ? `$${Number(totalPost).toFixed(2)}` : null;
      try {
        await fetchWithTimeout(`${BASE_URL}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to:         x.email,
            subject:    `Booking confirmed — ${prettyDate}`,
            type:       'booking_confirmation',
            clientName: x.name,
            date:       prettyDate,
            time:       time,
            service:    x.service || 'Cleaning',
            frequency:  x.frequency || null,
            address:    x.address || null,
            total:      totalLine,
            rushNote:   rushFee > 0 ? `A ${rushFee === 200 ? 'same-day' : rushFee === 100 ? 'next-day' : '2-day'} booking fee of $${rushFee} is included in your total.` : null,
          }),
        }, TIMEOUTS.RESEND);
      } catch (err) {
        await logError('accept-public-booking:confirm-email', err, { taskId, email: x.email });
        // Don't fail — the appointment is already saved.
      }
    }

    return res.status(200).json({
      success: true,
      appointmentId,
      clientId,
      leadId,
    });

  } catch (err) {
    await logError('accept-public-booking', err, { taskId });
    return res.status(500).json({ error: 'Could not accept booking', detail: err.message });
  }
}
