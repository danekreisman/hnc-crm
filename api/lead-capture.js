const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const d = req.body;
  if (!d || !d.name || !d.email || !d.phone || !d.address) {
    return res.status(400).json({ success: false, message: 'Please fill in all required fields.' });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const noteParts = [
    d.notes        || null,
    d.serviceType  ? 'Service: '   + d.serviceType  : null,
    d.frequency    ? 'Frequency: ' + d.frequency    : null,
    d.island       ? 'Island: '    + d.island       : null,
    d.beds         ? 'Beds: '      + d.beds         : null,
    d.baths        ? 'Baths: '     + d.baths        : null,
    d.sqft         ? 'Sqft: '      + d.sqft         : null,
    d.condition    ? 'Condition: ' + d.condition + '/10' : null,
  ].filter(Boolean);

  const { data, error } = await db.from('leads').insert([{
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

  if (error) {
    console.error('[lead-capture] Supabase error:', JSON.stringify(error));
    return res.status(500).json({ success: false, message: 'Error saving your request: ' + error.message });
  }

  return res.status(200).json({ success: true, leadId: data[0].id });
};
