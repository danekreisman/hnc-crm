import { createClient } from '@supabase/supabase-js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { isAutomationEnabled } from './utils/automation-gate.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const d = req.body;
  const invalid = validateOrFail(d, SCHEMAS.leadCapture);
  if (invalid) return res.status(400).json(invalid);

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

  // ── 2.5. Owner notification + OpenPhone contact creation (fire-and-forget) ─
  // We don't await these — if either fails, the lead is still saved and the
  // quote flow still runs. Errors are logged for inspection.
  const OWNER_EMAIL = 'dane.kreisman@gmail.com';
  const OWNER_PHONE = '+18082697636';

  const ownerSummary = `New lead: ${d.name} (${d.serviceType||'cleaning'}) | ${d.phone}${d.island?' | '+d.island:''}${d.beds?' | '+d.beds+'bd':''}${d.baths?'/'+d.baths+'ba':''}${d.sqft?' | '+d.sqft+'sf':''}`;

  const ownerEmailBody = [
    'A new lead just came in via the website.',
    '',
    `Name: ${d.name}`,
    `Phone: ${d.phone}`,
    `Email: ${d.email}`,
    `Service: ${d.serviceType || '—'}`,
    `Frequency: ${d.frequency || '—'}`,
    `Island: ${d.island || '—'}`,
    `Address: ${d.address || '—'}`,
    `Beds: ${d.beds || '—'}  Baths: ${d.baths || '—'}  Sqft: ${d.sqft || '—'}`,
    `Condition: ${d.condition ? d.condition + '/10' : '—'}`,
    `Referral: ${d.referralSource || '—'}`,
    d.notes ? `\nLead notes: ${d.notes}` : '',
    '',
    `Open in CRM: https://hnc-crm.vercel.app/?lead=${leadId}`
  ].filter(Boolean).join('\n');

  // (a) Owner email — gated by new_lead_owner_email_enabled
  if (await isAutomationEnabled(db, 'new_lead_owner_email_enabled')) {
    fetch(`${BASE_URL}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: OWNER_EMAIL,
        subject: `New lead: ${d.name} — ${d.serviceType || 'cleaning'}`,
        type: 'generic',
        clientName: 'Dane',
        notes: ownerEmailBody,
      })
    }).then(r => console.log('[lead-capture] owner email:', r.status))
      .catch(err => console.error('[lead-capture] owner email failed:', err.message));
  } else {
    console.log('[lead-capture] new_lead_owner_email disabled — skipping');
  }

  // (b) Owner SMS — gated by new_lead_owner_sms_enabled
  if (await isAutomationEnabled(db, 'new_lead_owner_sms_enabled')) {
    fetch(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: OWNER_PHONE, message: ownerSummary })
    }).then(r => console.log('[lead-capture] owner sms:', r.status))
      .catch(err => console.error('[lead-capture] owner sms failed:', err.message));
  } else {
    console.log('[lead-capture] new_lead_owner_sms disabled — skipping');
  }

  // (c) OpenPhone contact creation — so the lead's name appears in OpenPhone
  // when they call. We attempt unconditionally; OpenPhone may dedupe by phone.
  // Failure is non-fatal (logged only).
  try {
    const nameParts = d.name.trim().split(/\s+/);
    const opFirst = nameParts[0] || d.name.trim();
    const opLast  = nameParts.slice(1).join(' ') || undefined;
    const opBody = {
      defaultFields: {
        firstName: opFirst,
        company: d.serviceType === 'Janitorial Cleaning' || d.serviceType === 'Commercial Cleaning' ? (d.address || undefined) : undefined,
        emails: d.email ? [{ name: 'email', value: d.email.trim() }] : [],
        phoneNumbers: [{ name: 'phone', value: e164 }]
      },
      source: 'HNC CRM lead form',
      externalId: leadId,
    };
    if (opLast) opBody.defaultFields.lastName = opLast;

    fetch('https://api.openphone.com/v1/contacts', {
      method: 'POST',
      headers: {
        'Authorization': process.env.QUO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(opBody)
    })
      .then(async r => {
        const text = await r.text();
        console.log('[lead-capture] openphone contact:', r.status, text.slice(0, 200));
      })
      .catch(err => console.error('[lead-capture] openphone contact failed:', err.message));
  } catch (err) {
    console.error('[lead-capture] openphone contact build failed:', err.message);
  }

  function applyVars(template, extra = {}) {
    return template
      .replace(/\{firstName\}/g, firstName)
      .replace(/\{service\}/g,   d.serviceType || 'cleaning')
      .replace(/\{frequency\}/g, d.frequency   || '')
      .replace(/\{total\}/g,     extra.total   || '');
  }

  // ── 3. Janitorial branch ────────────────────────────────────────────────
  if (isJanitorial) {
    const janEnabled = await isAutomationEnabled(db, 'janitorial_enabled');
    if (!janEnabled) {
      console.log('[lead-capture] janitorial_enabled is FALSE — skipping janitorial walkthrough send');
      return res.status(200).json({ success: true, leadId, skipped: 'janitorial_enabled is FALSE' });
    }
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

    // Mark quote_sent_at so we know something was sent + advance stage to Quoted
    await db.from('leads').update({
      quote_sent_at: new Date().toISOString(),
      stage: 'Quoted'
    }).eq('id', leadId);

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
    const autoQuoteEnabled = await isAutomationEnabled(db, 'auto_quote_enabled');
    if (!autoQuoteEnabled) {
      console.log('[lead-capture] auto_quote_enabled is FALSE — skipping quote email/SMS send');
      return res.status(200).json({ success: true, leadId, skipped: 'auto_quote_enabled is FALSE' });
    }
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

    const quoteUpdate = { quote_sent_at: new Date().toISOString(), quote_data: quoteResult, stage: 'Quoted' };
    if (!isCustom && quoteResult.total != null) quoteUpdate.quote_total = quoteResult.total;
    const { error: updateErr } = await db.from('leads').update(quoteUpdate).eq('id', leadId);
    if (updateErr) console.error('[lead-capture] update quote fields error:', JSON.stringify(updateErr));
    else console.log('[lead-capture] quote stored on lead', leadId);
  }

  return res.status(200).json({ success: true, leadId });
}
