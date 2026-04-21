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
  const bookingToken = crypto.randomUUID();
  const isJanitorial = (d.serviceType === 'Janitorial Cleaning');

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
    booking_token: bookingToken,
    notes:        noteParts.join('\n') || null,
  }]).select();

  if (insertError) {
    console.error('[lead-capture] insert error:', JSON.stringify(insertError));
    return res.status(500).json({ success: false, message: insertError.message });
  }

  const leadId    = insertData[0].id;
  const firstName = d.name.trim().split(' ')[0];
  const phone     = d.phone.replace(/\D/g, '');
  const e164      = phone.startsWith('+') ? phone : '+1' + phone;

  function applyVars(template, extra = {}) {
    return template
      .replace(/\{firstName\}/g, firstName)
      .replace(/\{service\}/g,   d.serviceType || 'cleaning')
      .replace(/\{frequency\}/g, d.frequency   || '')
      .replace(/\{total\}/g,     extra.total   || '');
  }

  // ── 3. Janitorial branch ────────────────────────────────────────────────
  if (isJanitorial) {
    let janSms = null, janSubject = null, janIntro = null;
    try {
      const [sr, subr, intr] = await Promise.all([
        db.from('settings').select('value').eq('key','janitorial_sms_template').maybeSingle(),
        db.from('settings').select('value').eq('key','janitorial_email_subject').maybeSingle(),
        db.from('settings').select('value').eq('key','janitorial_email_intro').maybeSingle(),
      ]);
      if (sr.data?.value)   janSms     = sr.data.value;
      if (subr.data?.value) janSubject  = subr.data.value;
      if (intr.data?.value) janIntro    = intr.data.value;
    } catch(err) { console.warn('[lead-capture] janitorial settings load failed:', err.message); }

    const defaultSms     = `Aloha ${firstName}, we've received your request for Janitorial Cleaning. Would you be available for a walkthrough sometime this week?`;
    const defaultSubject = `Your Janitorial Cleaning Request — Hawaii Natural Clean`;
    const defaultIntro   = `Aloha ${firstName}, thanks for reaching out! We've received your Janitorial Cleaning request and would love to schedule a walkthrough to give you an accurate quote.`;

    const smsBody      = janSms     ? applyVars(janSms)     : defaultSms;
    const emailSubject = janSubject ? applyVars(janSubject)  : defaultSubject;
    const emailIntro   = janIntro   ? applyVars(janIntro)    : defaultIntro;

    // Send email
    try {
      const emailRes = await fetch(`${BASE_URL}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: d.email.trim(), subject: emailSubject,
          type: 'generic', clientName: firstName,
          notes: emailIntro,
        })
      });
      console.log('[lead-capture] janitorial email sent:', emailRes.status);
    } catch(err) { console.error('[lead-capture] janitorial email failed:', err.message); }

    // Send SMS
    try {
      const smsRes = await fetch(`${BASE_URL}/api/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: e164, message: smsBody })
      });
      console.log('[lead-capture] janitorial SMS sent:', smsRes.status);
    } catch(err) { console.error('[lead-capture] janitorial SMS failed:', err.message); }

    // Mark quote_sent_at so we know something was sent
    await db.from('leads').update({ quote_sent_at: new Date().toISOString() }).eq('id', leadId);

    return res.status(200).json({ success: true, leadId });
  }

  // ── 4. Load quote templates (non-Janitorial) ────────────────────────────
  let customSmsTemplate = null, customEmailSubject = null, customEmailIntro = null;
  try {
    const [smsRow, subjectRow, introRow] = await Promise.all([
      db.from('settings').select('value').eq('key','quote_sms_template').maybeSingle(),
      db.from('settings').select('value').eq('key','quote_email_subject').maybeSingle(),
      db.from('settings').select('value').eq('key','quote_email_intro').maybeSingle(),
    ]);
    if (smsRow.data?.value)     customSmsTemplate  = smsRow.data.value;
    if (subjectRow.data?.value) customEmailSubject = subjectRow.data.value;
    if (introRow.data?.value)   customEmailIntro   = introRow.data.value;
  } catch(err) { console.warn('[lead-capture] failed to load templates:', err.message); }

  // ── 5. Calculate quote ──────────────────────────────────────────────────
  let quoteResult = null;
  try {
    const quoteRes = await fetch(`${BASE_URL}/api/calculate-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceType: d.serviceType || null,
        beds: d.beds || null, baths: d.baths || null,
        sqft: d.sqft || null, condition: d.condition || null,
        frequency: d.frequency || null,
      })
    });
    quoteResult = await quoteRes.json();
    console.log('[lead-capture] quote result:', JSON.stringify(quoteResult));
  } catch(err) { console.error('[lead-capture] calculate-quote failed:', err.message); }

  // ── 6. Send quote email + SMS ───────────────────────────────────────────
  if (quoteResult && !quoteResult.error) {
    const isCustom  = quoteResult.custom_quote === true;
    const totalStr  = isCustom ? 'custom' : `$${Number(quoteResult.total).toFixed(2)}`;
    const extraVars = { total: isCustom ? 'custom' : Number(quoteResult.total).toFixed(2) };

    const subject = customEmailSubject
      ? applyVars(customEmailSubject, extraVars)
      : (isCustom ? `Hi ${firstName} — your Hawaii Natural Clean quote` : `Your Hawaii Natural Clean quote: ${totalStr}`);

    const smsBody = customSmsTemplate
      ? applyVars(customSmsTemplate, extraVars)
      : (isCustom
          ? `Hi ${firstName}! Thanks for reaching out to Hawaii Natural Clean. Your service requires a custom quote — we'll follow up within 24 hours. Questions? Call/text (808) 468-5356 🌺`
          : `Hi ${firstName}! Your Hawaii Natural Clean quote is ${totalStr} for ${d.serviceType || 'cleaning'}. Ready to book? Reply or call (808) 468-5356 🌺`);

    const emailIntro = customEmailIntro ? applyVars(customEmailIntro, extraVars) : null;

    try {
      const emailRes = await fetch(`${BASE_URL}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: d.email.trim(), subject,
          type: isCustom ? 'generic' : 'quote',
          clientName: firstName, service: d.serviceType || 'Cleaning',
          frequency: d.frequency || null,
          quoteData: isCustom ? null : quoteResult,
          customIntro: emailIntro,
          bookingToken: bookingToken,
          notes: isCustom ? `Thanks for reaching out! Your request (${d.serviceType}) requires a custom quote. We'll follow up within 24 hours — or call/text us at (808) 468-5356.` : null,
        })
      });
      console.log('[lead-capture] email sent:', emailRes.status);
    } catch(err) { console.error('[lead-capture] send-email failed:', err.message); }

    try {
      const smsRes = await fetch(`${BASE_URL}/api/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: e164, message: smsBody })
      });
      console.log('[lead-capture] SMS sent:', smsRes.status);
    } catch(err) { console.error('[lead-capture] send-sms failed:', err.message); }

    const quoteUpdate = { quote_sent_at: new Date().toISOString(), quote_data: quoteResult };
    if (!isCustom && quoteResult.total != null) quoteUpdate.quote_total = quoteResult.total;
    const { error: updateErr } = await db.from('leads').update(quoteUpdate).eq('id', leadId);
    if (updateErr) console.error('[lead-capture] update quote fields error:', JSON.stringify(updateErr));
    else console.log('[lead-capture] quote stored on lead', leadId);
  }

  return res.status(200).json({ success: true, leadId });
}
