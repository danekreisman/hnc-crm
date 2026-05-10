import { createClient } from '@supabase/supabase-js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';
import { isAutomationEnabled } from './utils/automation-gate.js';

// -- Activity Logger ----------------------------------------------------------
async function logActivity(action, description, metadata = {}) {
  try {
    await fetch(process.env.SUPABASE_URL + '/rest/v1/activity_logs', {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ action, description, user_email: 'system', entity_type: action, metadata })
    });
  } catch (_e) { /* non-blocking */ }
}
// -----------------------------------------------------------------------------


const db = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BASE_URL = 'https://hnc-crm.vercel.app';


async function isNotifEnabled(db, clientId, key) {
  if (!clientId) return true;
  const { data } = await db.from('clients').select('notification_prefs').eq('id', clientId).maybeSingle();
  const prefs = { booking_confirmation:true, day_before_reminder:true, invoice_reminder:true, policy_reminder:true, post_clean_email:true, review_request:true, ...(data?.notification_prefs || {}) };
  return prefs[key] !== false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // -- GET: validate token → return lead + quote data --------------------
  if (req.method === 'GET') {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const supabase = db();
    const { data: lead, error } = await supabase
      .from('leads')
      .select('id,name,email,phone,address,service,sqft,quote_total,quote_data,notes,booking_token,created_at')
      .eq('booking_token', token)
      .maybeSingle();

    if (error || !lead) return res.status(404).json({ error: 'Invalid or expired link' });

    const age = (Date.now() - new Date(lead.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (age > 30) return res.status(410).json({ error: 'This booking link has expired. Please contact us for a new quote.' });

    const parse = (pattern) => {
      const m = lead.notes && pattern.exec(lead.notes);
      return m ? m[1].trim() : null;
    };

    return res.status(200).json({
      name:       lead.name,
      firstName:  lead.name.trim().split(' ')[0],
      email:      lead.email,
      phone:      lead.phone,
      address:    lead.address,
      service:    lead.service,
      sqft:       lead.sqft,
      frequency:  parse(/Frequency:\s*([^\n]+)/),
      island:     parse(/Island:\s*([^\n]+)/) || 'Oahu',
      beds:       parse(/Beds:\s*(\S+)/),
      baths:      parse(/Baths:\s*(\S+)/),
      condition:  parse(/Condition:\s*(\d+)/),
      quoteTotal: lead.quote_total,
      quoteData:  lead.quote_data,
      leadId:     lead.id,
    });
  }

  // -- POST: book ---------------------------------------------------------
  if (req.method === 'POST') {
    const { token, date, time, notes, service, rushFee } = req.body;
    const invalid = validateOrFail(req.body, SCHEMAS.booking);
    if (invalid) return res.status(400).json(invalid);

    const supabase = db();

    // 1. Look up lead
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('id,name,email,phone,address,service,sqft,quote_total,quote_data,notes,booking_token,stage')
      .eq('booking_token', token)
      .maybeSingle();

    if (leadErr || !lead) return res.status(404).json({ error: 'Invalid token' });

    // Guard against double-submissions — lead already booked
    if (lead.stage === 'Closed won') {
      return res.status(409).json({
        error: "You're already booked! If you need to make changes, please call or text us at (808) 468-5356."
      });
    }

    const firstName = lead.name.trim().split(' ')[0];
    const rawPhone  = (lead.phone || '').trim();
    const phone     = rawPhone.replace(/\D/g, '');
    const e164      = rawPhone.startsWith('+') ? rawPhone.replace(/[^0-9+]/g, '') : '+1' + phone;
    const quoteData = lead.quote_data || {};
    const TAX_RATE  = 0.04712;

    const parse = (pattern) => {
      const m = lead.notes && pattern.exec(lead.notes);
      return m ? m[1].trim() : null;
    };

    const island       = parse(/Island:\s*([^\n]+)/) || 'Oahu';
    const frequency    = parse(/Frequency:\s*([^\n]+)/);
    const beds         = parse(/Beds:\s*(\S+)/);
    const baths        = parse(/Baths:\s*(\S+)/);
    const preTotal     = quoteData.total != null ? Number(quoteData.total) : (lead.quote_total ? Number(lead.quote_total) : null);
    const tax          = preTotal != null ? +(preTotal * TAX_RATE).toFixed(2) : null;
    const totalWithTax = preTotal != null ? +(preTotal + tax + (rushFee || 0)).toFixed(2) : null;
    const durationHrs  = quoteData.duration_minutes ? quoteData.duration_minutes / 60 : null;

    const apptNotes = [
      'Booked via portal',
      rushFee > 0 ? `Rush fee: $${rushFee} (${rushFee === 200 ? 'same-day' : rushFee === 100 ? 'next-day' : '2-day'})` : null,
      notes || null,
    ].filter(Boolean).join('\n');

    // -- 2. Pretty-format the requested date for notifications -------------
    const prettyDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const prettyShort = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric'
    });
    const rushTag = rushFee > 0
      ? ' \u26A1 ' + (rushFee === 200 ? 'SAME-DAY' : rushFee === 100 ? 'NEXT-DAY' : '2-DAY')
      : '';
    const cleanName = (lead.name || '').trim();

    // -- 3. Guard: don't create a duplicate review task for the same lead --
    // If Dane hasn't yet accepted the previous booking request from this
    // lead, don't pile on another. The customer's UI guards on lead.stage
    // 'Closed won' but with the review-flow shift the lead stays in
    // earlier stages until acceptance, so we need a task-level guard too.
    {
      const dupCheck = await fetchWithTimeout(
        `${process.env.SUPABASE_URL}/rest/v1/tasks?select=id&type=eq.review_public_booking&status=eq.open&extracted_data->>lead_id=eq.${lead.id}&limit=1`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
          }
        },
        TIMEOUTS.SUPABASE
      ).catch(() => null);
      if (dupCheck && dupCheck.ok) {
        const rows = await dupCheck.json().catch(() => []);
        if (Array.isArray(rows) && rows.length > 0) {
          return res.status(409).json({
            error: "You've already submitted a request — our team is reviewing it. We'll be in touch shortly. If you need to make changes, call or text us at (808) 468-5356."
          });
        }
      }
    }

    // -- 4. Build task title + description ---------------------------------
    const taskTitle = 'Booking request \u2014 ' + cleanName
      + (rushTag ? rushTag : '')
      + ' \u00B7 ' + prettyShort
      + ' at ' + time;

    const description = [
      'BOOKING REQUEST (token-link flow)',
      '',
      'Customer:  ' + cleanName,
      'Phone:     ' + (lead.phone || '\u2014'),
      'Email:     ' + (lead.email || '\u2014'),
      'Address:   ' + (lead.address || '\u2014'),
      'Island:    ' + island,
      '',
      'Service:   ' + (lead.service || service || '\u2014'),
      frequency  ? 'Frequency: ' + frequency : null,
      beds       ? 'Beds:      ' + beds      : null,
      baths      ? 'Baths:     ' + baths     : null,
      lead.sqft  ? 'Sqft:      ' + lead.sqft : null,
      '',
      'Requested: ' + date + ' at ' + time,
      rushFee > 0 ? 'Rush fee:  $' + rushFee + ' (' + (rushFee === 200 ? 'same-day' : rushFee === 100 ? 'next-day' : '2-day') + ')' : null,
      totalWithTax != null ? 'Quote:     $' + totalWithTax + ' (incl. tax' + (rushFee > 0 ? ' + rush' : '') + ')' : 'Quote:     custom',
      '',
      notes ? 'Customer notes: ' + notes : null,
      '',
      'Path: token-link from auto-quote SMS \u2014 leadId ' + lead.id,
    ].filter(Boolean).join('\n');

    const today = new Date().toISOString().split('T')[0];

    // -- 5. Insert the review_public_booking task --------------------------
    // Shape mirrors submit-public-booking.js so accept-public-booking can
    // process this task identically. path='new_quote' + lead_id makes
    // book_lead_atomic reuse the existing lead instead of creating a dup.
    const taskRes = await fetchWithTimeout(`${process.env.SUPABASE_URL}/rest/v1/tasks`, {
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
          path:           'new_quote',
          name:           cleanName,
          email:          (lead.email || '').trim(),
          phone:          phone,
          address:        lead.address || null,
          island:         island,
          service:        lead.service || service || 'Regular Cleaning',
          frequency:      frequency || null,
          beds:           beds || null,
          baths:          baths || null,
          sqft:           lead.sqft ? String(lead.sqft) : null,
          condition:      parse(/Condition:\s*(\d+)/),
          requested_date: date,
          requested_time: time,
          customer_notes: notes || null,
          quote_total_pretax:   preTotal,
          quote_tax:            tax,
          rush_fee:             rushFee || 0,
          quote_total_with_tax: totalWithTax,
          quote_data:           quoteData || null,
          lead_id:              lead.id,
          client_id:            null,
          property_address:     null,
          source:               'Public booking form (token link)',
          submitted_at:         new Date().toISOString(),
          // policiesAgreed is required by SCHEMAS.booking; if we got here it
          // was true (validateOrFail above would have rejected otherwise).
          policies_agreed_at:   new Date().toISOString(),
        },
      }),
    }, TIMEOUTS.SUPABASE);

    if (!taskRes.ok) {
      const errBody = await taskRes.text().catch(() => '<unreadable>');
      await logError('lead-book:task-insert', new Error('Task insert ' + taskRes.status), {
        leadId: lead.id, body: errBody.slice(0, 500),
      });
      return res.status(500).json({
        success: false,
        error: 'Could not save your request. Please call (808) 468-5356.',
      });
    }

    let taskRowId = null;
    try {
      const taskRows = await taskRes.json();
      if (Array.isArray(taskRows) && taskRows[0] && taskRows[0].id) taskRowId = taskRows[0].id;
    } catch (_e) { /* non-fatal */ }

    // -- 6. Notifications: bell + push + owner email + owner SMS ----------
    // All four awaited via Promise.allSettled before responding so Vercel
    // doesn't kill them mid-flight (the bug that bit Kai's submission on
    // 2026-05-09). SMS goes to Dane's PERSONAL number, not the OpenPhone
    // business line — OpenPhone refuses to deliver self-to-self messages,
    // which is why the previous admin-SMS path was silently broken.
    const prettyReq = prettyShort + ' at ' + time;
    const displayTotal = totalWithTax;

    const inAppNotifyPromise = (async () => {
      try {
        await fetchWithTimeout(`${process.env.SUPABASE_URL}/rest/v1/notifications`, {
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
            body: prettyReq + ' \u00b7 ' + (lead.service || service || 'Cleaning')
                  + (frequency ? ' (' + frequency + ')' : '')
                  + (displayTotal != null ? ' \u00b7 $' + displayTotal.toFixed(2) : ''),
            url: '/#tasks',
            metadata: {
              source: 'public_booking',
              taskId: taskRowId,
              leadId: lead.id,
              clientId: null,
              name: cleanName,
              phone: phone,
              service: lead.service || service,
              path: 'new_quote',
              requestedDate: date,
              requestedTime: time,
              rushFee: rushFee || 0,
              flow: 'token-link',
            },
          }),
        }, TIMEOUTS.SUPABASE);
      } catch (err) {
        await logError('lead-book:in-app-notify', err, { leadId: lead.id, taskRowId });
      }
    })();

    const pushNotifyPromise = (async () => {
      try {
        const { sendPushToAllSubscribed } = await import('./utils/send-push.js');
        await sendPushToAllSubscribed({
          title: 'Booking request \u2014 ' + cleanName + rushTag,
          body: prettyReq + ' \u00b7 ' + (lead.service || service || 'Cleaning')
                + (displayTotal != null ? ' \u00b7 $' + displayTotal.toFixed(2) : ''),
          url: '/#tasks',
          tag: 'public-booking-' + lead.id,
          urgency: 'high',
        });
      } catch (err) {
        await logError('lead-book:push-notify', err, { leadId: lead.id, taskRowId });
      }
    })();

    const OWNER_EMAIL = 'dane@hawaiinaturalclean.net';
    const ownerEmailPromise = fetchWithTimeout(`${BASE_URL}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: OWNER_EMAIL,
        subject: 'New booking request: ' + cleanName + ' \u2014 ' + (lead.service || service || 'Cleaning'),
        type: 'generic',
        clientName: 'Dane',
        notes: description + '\n\nReview in CRM: https://hnc-crm.vercel.app/#tasks',
      }),
    }, TIMEOUTS.RESEND).catch((err) => {
      logError('lead-book:owner-email', err, { leadId: lead.id });
    });

    // Personal phone — OpenPhone refuses self-to-self, so this CAN'T be the
    // HNC business line.
    const OWNER_PHONE = '+18082697636';
    const smsLines = [
      'Booking request' + (rushTag ? rushTag : '') + ': ' + cleanName,
      lead.phone ? '\u00B7 ' + lead.phone : null,
      '\u00B7 ' + (lead.service || service || 'Cleaning') + (frequency ? ' (' + frequency + ')' : ''),
      '\u00B7 ' + prettyReq,
      displayTotal != null ? '\u00B7 $' + displayTotal.toFixed(2) : null,
      '\u00B7 token-link flow',
      '',
      'Review: hnc-crm.vercel.app/#tasks',
    ].filter(Boolean).join(' ').replace(/\s+\u00B7/g, '\n\u00B7');

    const ownerSmsPromise = fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: OWNER_PHONE, message: smsLines }),
    }, TIMEOUTS.OPENPHONE).then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '<unreadable>');
        await logError('lead-book:owner-sms', new Error('send-sms ' + r.status), {
          leadId: lead.id, taskRowId, body: body.slice(0, 500),
        });
      }
    }).catch(async (err) => {
      await logError('lead-book:owner-sms', err, { leadId: lead.id, taskRowId });
    });

    await Promise.allSettled([inAppNotifyPromise, pushNotifyPromise, ownerEmailPromise, ownerSmsPromise]);

    // -- 7. Done. Lead stays open until Dane accepts via the review modal -

  await logActivity('lead_booking_requested', 'Booking request received from lead: ' + (lead.name || 'Unknown'), {
    leadId: lead.id, name: lead.name, service: lead.service, date, time,
  });
    return res.status(200).json({
      success: true,
      requestReceived: true,
      leadId: lead.id,
      taskId: taskRowId,
      requestedDate: date,
      requestedTime: time,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
