import { createClient } from '@supabase/supabase-js';

const db = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── GET: validate token, return lead + quote data ─────────────────────
  if (req.method === 'GET') {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const supabase = db();
    const { data: lead, error } = await supabase
      .from('leads')
      .select('id,name,email,service,quote_total,quote_data,notes,booking_token,created_at')
      .eq('booking_token', token)
      .maybeSingle();

    if (error || !lead) return res.status(404).json({ error: 'Invalid or expired link' });

    // Tokens expire after 30 days
    const age = (Date.now() - new Date(lead.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (age > 30) return res.status(410).json({ error: 'This booking link has expired. Please contact us for a new quote.' });

    // Parse frequency from notes
    const freqMatch = lead.notes && /Frequency:\s*([^\n]+)/.exec(lead.notes);
    const bedsMatch = lead.notes && /Beds:\s*(\S+)/.exec(lead.notes);
    const bathsMatch = lead.notes && /Baths:\s*(\S+)/.exec(lead.notes);

    return res.status(200).json({
      name:      lead.name,
      firstName: lead.name.trim().split(' ')[0],
      email:     lead.email,
      service:   lead.service,
      frequency: freqMatch ? freqMatch[1].trim() : null,
      beds:      bedsMatch ? bedsMatch[1] : null,
      baths:     bathsMatch ? bathsMatch[1] : null,
      quoteTotal: lead.quote_total,
      quoteData:  lead.quote_data,
      leadId:     lead.id,
    });
  }

  // ── POST: submit booking request ──────────────────────────────────────
  if (req.method === 'POST') {
    const { token, date, time, notes, service } = req.body;
    if (!token || !date) return res.status(400).json({ error: 'Missing required fields' });

    const supabase = db();
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('id,name,email,service,quote_total')
      .eq('booking_token', token)
      .maybeSingle();

    if (leadErr || !lead) return res.status(404).json({ error: 'Invalid token' });

    // Update lead stage to Quoted
    await supabase.from('leads').update({ stage: 'Quoted' }).eq('id', lead.id);

    // Log booking request as a note on the lead
    const requestNote = [
      `📅 BOOKING REQUEST via portal`,
      `Date: ${date}`,
      `Time: ${time || 'Flexible'}`,
      notes ? `Notes: ${notes}` : null,
    ].filter(Boolean).join('\n');

    const { data: existing } = await supabase
      .from('leads').select('notes').eq('id', lead.id).maybeSingle();
    const updatedNotes = existing?.notes
      ? existing.notes + '\n\n' + requestNote
      : requestNote;

    await supabase.from('leads').update({ notes: updatedNotes }).eq('id', lead.id);

    // Notify via SMS to HNC number
    const BASE_URL = 'https://hnc-crm.vercel.app';
    const adminSms = `📅 New booking request from ${lead.name}!\nService: ${lead.service || service}\nDate: ${date} at ${time || 'flexible'}\nQuote: ${lead.quote_total ? '$'+Number(lead.quote_total).toFixed(2) : 'TBD'}`;
    try {
      await fetch(`${BASE_URL}/api/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '+18083484888', message: adminSms }) // Dane's number
      });
    } catch(e) { console.warn('admin SMS failed', e.message); }

    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
