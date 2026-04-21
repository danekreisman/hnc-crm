import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'Missing clientId' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const { error } = await db
    .from('clients')
    .update({ policies_agreed_at: new Date().toISOString() })
    .eq('id', clientId);

  if (error) {
    console.error('[policy-agree] error:', JSON.stringify(error));
    return res.status(500).json({ error: error.message });
  }

  console.log('[policy-agree] client', clientId, 'agreed to policies');
  return res.status(200).json({ success: true });
}
