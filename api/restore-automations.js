export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { createClient } = await import('@supabase/supabase-js');
  
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // Restore the original automations
  const oldAutomations = [
    {
      name: 'New Lead — Auto Quote',
      enabled: true,
      trigger: 'form_submission',
      trigger_value: 'all',
      logic: 'AND'
    },
    {
      name: 'Janitorial Lead — Walkthrough Request',
      enabled: true,
      trigger: 'form_submission',
      trigger_value: 'all',
      logic: 'AND'
    }
  ];

  try {
    // Check if they already exist
    const { data: existing } = await db
      .from('automations')
      .select('id')
      .in('name', oldAutomations.map(a => a.name));

    if (existing && existing.length === oldAutomations.length) {
      return res.status(200).json({ 
        success: true, 
        message: 'Old automations already exist',
        count: existing.length 
      });
    }

    // Insert missing automations
    const { data, error } = await db
      .from('automations')
      .insert(oldAutomations)
      .select();

    if (error) throw error;

    console.log(`[restore-automations] Restored ${data.length} automations`);
    return res.status(200).json({
      success: true,
      restored: data.length,
      automations: data
    });
  } catch (error) {
    console.error('[restore-automations]', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
