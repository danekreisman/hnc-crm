import { createClient } from '@supabase/supabase-js';
import { logActivity } from './utils/log-activity.js';

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

  // Look up the client name for a friendlier activity-log description.
  // Defensive: if this fails for any reason, fall through to a generic
  // label — we don't want logging quirks to block the policy-agree
  // operation itself.
  let clientName = null;
  try {
    const { data: c } = await db.from('clients').select('name').eq('id', clientId).maybeSingle();
    if (c && c.name) clientName = c.name;
  } catch (_) {}

  const { error } = await db
    .from('clients')
    .update({ policies_agreed_at: new Date().toISOString() })
    .eq('id', clientId);

  if (error) {
    console.error('[policy-agree] error:', JSON.stringify(error));
    return res.status(500).json({ error: error.message });
  }

  // Log the signing event so it shows on the client's Activity feed.
  // This is an opt-in customer action — they clicked the Agree button
  // on /agree.html — so user_email is 'system' (the policy page acted
  // on their click, no admin involved).
  await logActivity(
    'policy_agreed',
    `${clientName || 'Client'} signed the policy waiver`,
    { client_id: clientId, signed_at: new Date().toISOString() },
    { user_email: 'system' },
  );

  console.log('[policy-agree] client', clientId, 'agreed to policies');
  return res.status(200).json({ success: true });
}
