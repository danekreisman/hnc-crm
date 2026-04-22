import { createClient } from '@supabase/supabase-js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const db = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BASE_URL = 'https://hnc-crm.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── GET: validate token → return lead + quote data ────────────────────
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

  // ── POST: book ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { token, date, time, notes, service, rushFee } = req.body;
    const invalid = validateOrFail(req.body, SCHEMAS.booking);
    if (invalid) return res.status(400).json(invalid);

    const supabase = db();

    // 1. Look up lead
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('id,name,email,phone,address,service,sqft,quote_total,quote_data,notes,booking_token')
      .eq('booking_token', token)
      .maybeSingle();

    if (leadErr || !lead) return res.status(404).json({ error: 'Invalid token' });

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

    // ── 2-4. ATOMIC: find/create client + appointment + close lead ────────
    // Uses a PostgreSQL stored procedure so all 3 steps succeed or all roll back.
    // No more "client created but no appointment" state.
    const { data: bookingResult, error: bookingErr } = await supabase.rpc('book_lead_atomic', {
      p_lead_id: lead.id,
      p_client_data: {
        name:      lead.name.trim(),
        email:     lead.email.trim(),
        phone:     phone || null,
        address:   lead.address || null,
        type:      'Residential',
        service:   lead.service || null,
        frequency: frequency    || null,
        beds:      beds         || null,
        baths:     baths        || null,
        sqft:      lead.sqft    ? String(lead.sqft) : null,
        status:    'New',
        notes:     'Created automatically from booking portal',
      },
      p_appointment_data: {
        service:        lead.service || service || 'Regular Cleaning',
        frequency:      frequency    || null,
        date:           date,
        time:           time,
        address:        lead.address || null,
        beds:           beds         || null,
        baths:          baths        || null,
        sqft:           lead.sqft    ? String(lead.sqft) : null,
        status:         'scheduled',
        base_price:     quoteData.subtotal  != null ? String(quoteData.subtotal)  : null,
        discount:       quoteData.discount  != null ? String(quoteData.discount)  : '0',
        tax:            tax                 != null ? String(tax)                 : null,
        total_price:    totalWithTax        != null ? String(totalWithTax)        : null,
        duration_hours: durationHrs         != null ? String(durationHrs)         : null,
        notes:          apptNotes,
      }
    });

    if (bookingErr) {
      await logError('lead-book', bookingErr, { leadId: lead.id, token, date, time });
      return res.status(500).json({
        success: false,
        error: 'Booking failed — no changes were saved. Please try again.',
        detail: bookingErr.message
      });
    }

    const { client_id: clientId, appointment_id: appointmentId } = bookingResult;
    console.log('[lead-book] Booking committed atomically — client:', clientId, 'appointment:', appointmentId);

    // ── 5. Format date ─────────────────────────────────────────────────────
    const prettyDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const rushNote = rushFee > 0
      ? ` A ${rushFee === 200 ? 'same-day' : rushFee === 100 ? 'next-day' : '2-day'} booking fee of $${rushFee} applies.`
      : '';

    // ── 6. Confirmation email (non-critical — booking already saved) ────────
    try {
      await fetchWithTimeout(`${BASE_URL}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:         lead.email.trim(),
          subject:    `Booking confirmed — ${prettyDate}`,
          type:       'generic',
          clientName: firstName,
          notes: `Your cleaning has been booked for <strong>${prettyDate} at ${time}</strong>. `
            + `Service: ${lead.service || 'Cleaning'}.${frequency ? ` Frequency: ${frequency}.` : ''}`
            + (totalWithTax ? ` Total: $${totalWithTax}.` : '')
            + rushNote
            + `<br><br>If you need to reschedule or have questions, call or text us at <strong>(808) 468-5356</strong>. We look forward to seeing you! 🌺`,
        })
      }, TIMEOUTS.RESEND);
      console.log('[lead-book] Confirmation email sent to', lead.email);
    } catch (err) {
      // Email failure does NOT fail the booking — it's already saved
      await logError('lead-book:confirmation-email', err, { leadId: lead.id, email: lead.email });
    }

    // ── 7. Admin SMS notification (non-critical) ───────────────────────────
    try {
      const adminSms = `✅ Auto-booked!\n${lead.name} · ${lead.service || 'Cleaning'}\n${prettyDate} at ${time}${totalWithTax ? '\nTotal: $' + totalWithTax : ''}${rushFee > 0 ? ' (incl. $' + rushFee + ' rush fee)' : ''}`;
      await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '+18083484888', message: adminSms })
      }, TIMEOUTS.OPENPHONE);
    } catch (err) {
      await logError('lead-book:admin-sms', err, { leadId: lead.id });
    }

    // ── 8. Policy agreement SMS — only if client hasn't already agreed ─────
    // New clients have policies_agreed_at = null. Existing clients who already
    // agreed are skipped automatically so they don't get a repeat message.
    try {
      const { data: clientRecord } = await supabase
        .from('clients')
        .select('policies_agreed_at')
        .eq('id', clientId)
        .maybeSingle();

      if (clientRecord && !clientRecord.policies_agreed_at) {
        const policyLink = `${BASE_URL}/agree.html?c=${clientId}`;
        const policyMsg  = `Hi ${firstName}! Before your first cleaning with Hawaii Natural Clean, please take a moment to review and agree to our service policies: ${policyLink} 🌺`;
        await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: e164, message: policyMsg })
        }, TIMEOUTS.OPENPHONE);
        console.log('[lead-book] Policy agreement SMS sent to', e164);
      } else {
        console.log('[lead-book] Client already agreed to policies — skipping SMS');
      }
    } catch (err) {
      // Policy SMS failure does NOT fail the booking
      await logError('lead-book:policy-sms', err, { leadId: lead.id, clientId });
    }

    return res.status(200).json({
      success: true,
      appointmentId,
      clientId,
      date: prettyDate,
      time,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
