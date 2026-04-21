import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const d = req.body;
  if (!d || !d.name || !d.email || !d.phone || !d.address) {
    return res.status(400).json({ success: false, message: 'Please fill in all required fields.' });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const BASE_URL = 'https://hnc-crm.vercel.app';

  // ── 1. Build notes ──────────────────────────────────────────────────────
  const noteParts = [
    d.notes        || null,
    d.serviceType  ? 'Service: '   + d.serviceType      : null,
    d.frequency    ? 'Frequency: ' + d.frequency         : null,
    d.island       ? 'Island: '    + d.island            : null,
    d.beds         ? 'Beds: '      + d.beds              : null,
    d.baths        ? 'Baths: '     + d.baths             : null,
    d.sqft         ? 'Sqft: '      + d.sqft              : null,
    d.condition    ? 'Condition: ' + d.condition + '/10' : null,
  ].filter(Boolean);

  // ── 2. Insert lead ──────────────────────────────────────────────────────
  const { data: insertData, error: insertError } = await db.from('leads').insert([{
    name:         d.name.trim(),
    contact_name: d.name.trim(),
    email:        d.email.trim(),
    phone:        d.phone.replace(/\D/g, ''),
    address:      d.address.trim(),
    service:      d.serviceType || null,
    sqft:         d.sqft ? parseInt(d.sqft) : null,
    source:       d.referralSource || 'Website form',
    stage:        'New inquiry',
    assigned_to:  'VA',
    notes:        noteParts.join('\n') || null,
  }]).select();

  if (insertError) {
    console.error('[lead-capture] insert error:', JSON.stringify(insertError));
    return res.status(500).json({ success: false, message: insertError.message });
  }

  const leadId   = insertData[0].id;
  const firstName = d.name.trim().split(' ')[0];
  const phone    = d.phone.replace(/\D/g, '');
  const e164     = phone.startsWith('+') ? phone : '+1' + phone;

  // ── 3. Load custom templates from settings ──────────────────────────────
  let customSmsTemplate = null;
  let customEmailSubject = null;
  try {
    const [smsRow, subjectRow] = await Promise.all([
      db.from('settings').select('value').eq('key', 'quote_sms_template').maybeSingle(),
      db.from('settings').select('value').eq('key', 'quote_email_subject').maybeSingle(),
    ]);
    if (smsRow.data?.value)     customSmsTemplate  = smsRow.data.value;
    if (subjectRow.data?.value) customEmailSubject = subjectRow.data.value;
  } catch(err) {
    console.warn('[lead-capture] failed to load templates:', err.message);
  }

  // ── 4. Calculate quote ──────────────────────────────────────────────────
  let quoteResult = null;
  try {
    const quoteRes = await fetch(`${BASE_URL}/api/calculate-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceType: d.serviceType || null,
        beds:        d.beds        || null,
        baths:       d.baths       || null,
        sqft:        d.sqft        || null,
        condition:   d.condition   || null,
        frequency:   d.frequency   || null,
      })
    });
    quoteResult = await quoteRes.json();
    console.log('[lead-capture] quote result:', JSON.stringify(quoteResult));
  } catch (err) {
    console.error('[lead-capture] calculate-quote failed:', err.message);
  }

  // ── 5. Send email + SMS + update lead ───────────────────────────────────
  if (quoteResult && !quoteResult.error) {
    const isCustom = quoteResult.custom_quote === true;
    const totalStr = isCustom ? 'custom' : `$${Number(quoteResult.total).toFixed(2)}`;

    // Apply variable substitution helper
    function applyVars(template) {
      return template
        .replace(/\{firstName\}/g, firstName)
        .replace(/\{total\}/g,     isCustom ? 'custom' : Number(quoteResult.total).toFixed(2))
        .replace(/\{service\}/g,   d.serviceType || 'cleaning')
        .replace(/\{frequency\}/g, d.frequency   || '');
    }

    // Email subject
    const defaultSubject = isCustom
      ? `Hi ${firstName} — your Hawaii Natural Clean quote`
      : `Your Hawaii Natural Clean quote: ${totalStr}`;
    const subject = customEmailSubject ? applyVars(customEmailSubject) : defaultSubject;

    // SMS body
    const defaultSms = isCustom
      ? `Hi ${firstName}! Thanks for reaching out to Hawaii Natural Clean. Your service requires a custom quote — we'll follow up within 24 hours. Questions? Call/text (808) 468-5356 🌺`
      : `Hi ${firstName}! Your Hawaii Natural Clean quote is ${totalStr} for ${d.serviceType || 'cleaning'}. Ready to book? Reply or call (808) 468-5356 🌺`;
    const smsBody = customSmsTemplate ? applyVars(customSmsTemplate) : defaultSms;

    // Send email
    try {
      const emailRes = await fetch(`${BASE_URL}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:         d.email.trim(),
          subject,
          type:       isCustom ? 'generic' : 'quote',
          clientName: firstName,
          service:    d.serviceType || 'Cleaning',
          frequency:  d.frequency   || null,
          quoteData:  isCustom ? null : quoteResult,
          notes: isCustom
            ? `Thanks for reaching out! Your request (${d.serviceType}) requires a custom quote. We'll follow up within 24 hours — or call/text us at (808) 468-5356.`
            : null,
        })
      });
      const emailData = await emailRes.json();
      console.log('[lead-capture] email sent:', emailRes.status, JSON.stringify(emailData));
    } catch (err) {
      console.error('[lead-capture] send-email failed:', err.message);
    }

    // Send SMS
    try {
      const smsRes = await fetch(`${BASE_URL}/api/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: e164, message: smsBody })
      });
      const smsData = await smsRes.json();
      console.log('[lead-capture] SMS sent:', smsRes.status, JSON.stringify(smsData));
    } catch (err) {
      console.error('[lead-capture] send-sms failed:', err.message);
    }

    // Update lead with quote data
    const quoteUpdate = { quote_sent_at: new Date().toISOString(), quote_data: quoteResult };
    if (!isCustom && quoteResult.total != null) quoteUpdate.quote_total = quoteResult.total;
    const { error: updateErr } = await db.from('leads').update(quoteUpdate).eq('id', leadId);
    if (updateErr) console.error('[lead-capture] update quote fields error:', JSON.stringify(updateErr));
    else console.log('[lead-capture] quote stored on lead', leadId);
  }

  return res.status(200).json({ success: true, leadId });
}
