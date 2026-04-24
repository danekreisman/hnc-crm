import { createClient } from '@supabase/supabase-js';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  const { data } = await db.from('settings').select('value').eq('key', key).maybeSingle();
  return res.status(200).json({ value: data?.value || null });
}
