import { createClient } from '@supabase/supabase-js';

const db = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BASE_URL = 'https://hnc-crm.vercel.app';

// ── GET: validate token → return lead + quote data ────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

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

  // ── POST: auto-book ────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { token, date, time, notes, service, rushFee } = req.body;
    if (!token || !date || !time) return res.status(400).json({ error: 'Missing required fields' });

    const supabase = db();

    // 1. Look up lead
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('id,name,email,phone,address,service,sqft,quote_total,quote_data,notes,booking_token')
      .eq('booking_token', token)
      .maybeSingle();

    if (leadErr || !lead) return res.status(404).json({ error: 'Invalid token' });

    const firstName  = lead.name.trim().split(' ')[0];
    const phone      = (lead.phone || '').replace(/\D/g, '');
    const e164       = phone.startsWith('+') ? phone : '+1' + phone;
    const quoteData  = lead.quote_data || {};
    const TAX_RATE   = 0.04712;

    const parse = (pattern) => {
      const m = lead.notes && pattern.exec(lead.notes);
      return m ? m[1].trim() : null;
    };
    const island    = parse(/Island:\s*([^\n]+)/) || 'Oahu';
    const frequency = parse(/Frequency:\s*([^\n]+)/);
    const beds      = parse(/Beds:\s*(\S+)/);
    const baths     = parse(/Baths:\s*(\S+)/);

    const preTotal   = quoteData.total != null ? Number(quoteData.total) : (lead.quote_total ? Number(lead.quote_total) : null);
    const tax        = preTotal != null ? +(preTotal * TAX_RATE).toFixed(2) : null;
    const totalWithTax = preTotal != null ? +(preTotal + tax + (rushFee || 0)).toFixed(2) : null;
    const durationHrs  = quoteData.duration_minutes ? quoteData.duration_minutes / 60 : null;

    // 2. Find or create client
    let clientId = null;
    try {
      const { data: existing } = await supabase
        .from('clients')
        .select('id')
        .ilike('email', lead.email.trim())
        .maybeSingle();

      if (existing) {
        clientId = existing.id;
        console.log('[lead-book] found existing client', clientId);
      } else {
        const parsedFreq  = parse(/Frequency:\s*([^\n]+)/);
        const parsedBeds  = parse(/Beds:\s*(\S+)/);
        const parsedBaths = parse(/Baths:\s*(\S+)/);
        const { data: newClient, error: clientErr } = await supabase
          .from('clients')
          .insert({
            name:      lead.name.trim(),
            email:     lead.email.trim(),
            phone:     phone || null,
            address:   lead.address || null,
            type:      'Residential',
            service:   lead.service   || null,
            frequency: parsedFreq     || null,
            beds:      parsedBeds     ? parseFloat(parsedBeds)  : null,
            baths:     parsedBaths    ? parseFloat(parsedBaths) : null,
            sqft:      lead.sqft      || null,
            status:    'New',
            notes:     'Created automatically from booking portal',
          })
          .select('id')
          .single();

        if (clientErr) {
          console.error('[lead-book] create client error:', JSON.stringify(clientErr));
        } else {
          clientId = newClient.id;
          console.log('[lead-book] created new client', clientId);
        }
      }
    } catch (err) {
      console.error('[lead-book] client find/create error:', err.message);
    }

    // 3. Create appointment (cleaner assigned manually by team)
    let appointmentId = null;
    try {
      const apptPayload = {
        client_id:      clientId || undefined,
        service:        lead.service || service || 'Regular Cleaning',
        frequency:      frequency   || null,
        date:           date,
        time:           time,
        address:        lead.address || null,
        beds:           beds ? parseFloat(beds) : null,
        baths:          baths ? parseFloat(baths) : null,
        sqft:           lead.sqft || null,

        status:         'scheduled',
        base_price:     quoteData.subtotal != null ? Number(quoteData.subtotal) : null,
        discount:       quoteData.discount != null ? Number(quoteData.discount) : 0,
        tax:            tax,
        total_price:    totalWithTax,
        duration_hours: durationHrs,
        notes:          [
          'Booked via portal',
          rushFee > 0 ? `Rush fee: $${rushFee} (${rushFee === 200 ? 'same-day' : rushFee === 100 ? 'next-day' : '2-day'})` : null,
          notes || null,
        ].filter(Boolean).join('\n'),
      };

      const { data: appt, error: apptErr } = await supabase
        .from('appointments')
        .insert(apptPayload)
        .select('id')
        .single();

      if (apptErr) {
        console.error('[lead-book] create appointment error:', JSON.stringify(apptErr));
      } else {
        appointmentId = appt.id;
        console.log('[lead-book] appointment created:', appointmentId);
      }
    } catch (err) {
      console.error('[lead-book] appointment insert error:', err.message);
    }

    // 5. Update lead: stage → Closed won, mark quote sent
    await supabase
      .from('leads')
      .update({ stage: 'Closed won', quote_sent_at: new Date().toISOString() })
      .eq('id', lead.id);

    // 6. Format date nicely
    const prettyDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const rushNote = rushFee > 0
      ? ` A ${rushFee === 200 ? 'same-day' : rushFee === 100 ? 'next-day' : '2-day'} booking fee of $${rushFee} applies.`
      : '';

    // 7. Send confirmation email to lead
    try {
      await fetch(`${BASE_URL}/api/send-email`, {
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
      });
      console.log('[lead-book] confirmation email sent to', lead.email);
    } catch (err) {
      console.error('[lead-book] confirmation email failed:', err.message);
    }

    // 8. SMS admin notification
    try {
      const adminSms = `✅ Auto-booked!\n${lead.name} · ${lead.service || 'Cleaning'}\n${prettyDate} at ${time}${totalWithTax ? '\nTotal: $' + totalWithTax : ''}${rushFee > 0 ? ' (incl. $' + rushFee + ' rush fee)' : ''}`;
      await fetch(`${BASE_URL}/api/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '+18083484888', message: adminSms })
      });
    } catch (err) {
      console.error('[lead-book] admin SMS failed:', err.message);
    }

    return res.status(200).json({
      success: true,
      appointmentId,
      date: prettyDate,
      time,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
