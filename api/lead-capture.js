const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Method not allowed' }); }

  try {
    const d = req.body;

    // Basic validation
    if (!d.name || d.name.trim().length < 2) return res.status(400).json({ success:false, message:'Please enter your name.' });
    if (!d.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return res.status(400).json({ success:false, message:'Please enter a valid email.' });
    if (!d.phone || d.phone.replace(/\D/g,'').length < 10) return res.status(400).json({ success:false, message:'Please enter a valid phone number.' });
    if (!d.address || d.address.trim().length < 5) return res.status(400).json({ success:false, message:'Please enter your property address.' });

    const db = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Deduplicate — same email in last 24h
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data: existing } = await db.from('leads').select('id').eq('email', d.email.trim()).gte('created_at', since).limit(1);
    if (existing && existing.length > 0) {
      return res.status(200).json({ success:true, message:'Already submitted — we\'ll be in touch soon!' });
    }

    // Build notes from extra fields
    const noteParts = [
      d.notes || null,
      d.frequency   ? `Frequency: ${d.frequency}`            : null,
      d.island       ? `Island: ${d.island}`                  : null,
      d.beds         ? `Beds: ${d.beds}`                      : null,
      d.baths        ? `Baths: ${d.baths}`                    : null,
      d.condition    ? `Condition: ${d.condition}/10`         : null,
    ].filter(Boolean);

    // Insert lead
    const { data: lead, error } = await db.from('leads').insert([{
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
      notes:        noteParts.length ? noteParts.join('\n') : null,
    }]).select();

    if (error) {
      console.error('[lead-capture] insert error:', error);
      return res.status(500).json({ success:false, message:'Error saving your request. Please try again.' });
    }

    // Send welcome email (non-blocking — don't fail submission if this errors)
    if (RESEND_API_KEY) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Hawaii Natural Clean <hello@hawaiinatural.clean>',
          to: d.email.trim(),
          subject: 'We received your quote request — Mahalo!',
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a2e38">
            <h2 style="color:#3BB8E3">Mahalo, ${d.name.split(' ')[0]}! 🌺</h2>
            <p>We received your request for a <strong>${d.serviceType || 'cleaning'}</strong> at ${d.address}.</p>
            <p>We'll reach out within the hour to go over your quote and get you scheduled.</p>
            <p style="margin-top:28px;color:#888;font-size:13px">— The Hawaii Natural Clean team<br>Oahu &amp; Maui</p>
          </div>`
        })
      }).catch(e => console.error('[lead-capture] email error:', e));
    }

    return res.status(200).json({ success:true, message:'Lead captured successfully', leadId: lead[0].id });

  } catch (err) {
    console.error('[lead-capture] unexpected error:', err);
    return res.status(500).json({ success:false, message:'An unexpected error occurred. Please try again.' });
  }
};
