import { createClient } from '@supabase/supabase-js';
import { validateOrFail, validateActions, SCHEMAS } from './utils/validate.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, description, trigger_type, trigger_config, actions, is_enabled, created_by } = req.body;

  const invalid = validateOrFail(req.body, SCHEMAS.saveAutomation);
  if (invalid) return res.status(400).json(invalid);

  const actionErrors = validateActions(actions);
  if (actionErrors.length > 0) {
    return res.status(400).json({ success: false, error: 'Invalid actions', details: actionErrors });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { data, error } = await db
      .from('lead_automations')
      .insert([{
        name,
        description: description || '',
        trigger_type,
        trigger_config: trigger_config || {},
        actions,
        is_enabled: is_enabled !== false,
        created_by: created_by || 'API',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      automation: data[0]
    });
  } catch (error) {
    console.error('[save-automation]', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
