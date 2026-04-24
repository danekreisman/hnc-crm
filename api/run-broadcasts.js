/**
 * POST /api/run-broadcasts  (called by Vercel cron)
 *
 * Checks for any broadcast with status='scheduled' and scheduled_for <= now.
 * Fires each one by calling /api/send-broadcast internally.
 * Safe to run frequently — send-broadcast is idempotent.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

async function logActivity(action, description, metadata={}) {
  try {
    await fetch(process.env.SUPABASE_URL+'/rest/v1/activity_logs',{
      method:'POST',
      headers:{'apikey':process.env.SUPABASE_SERVICE_ROLE_KEY,'Authorization':'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({action,description,user_email:'system',entity_type:action,metadata})
    });
  } catch(_){}
}


const BASE_URL = 'https://hnc-crm.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const now = new Date().toISOString();

    // Find all broadcasts due to send
    const { data: due, error } = await db
      .from('broadcasts')
      .select('id, name, scheduled_for')
      .eq('status', 'scheduled')
      .lte('scheduled_for', now);

    if (error) throw error;
    if (!due || due.length === 0) {
      return res.status(200).json({ success: true, fired: 0, message: 'No broadcasts due' });
    }

    console.log(`[run-broadcasts] Found ${due.length} broadcast(s) due to send`);

    let fired = 0;
    const errors = [];

    for (const broadcast of due) {
      try {
        const resp = await fetch(`${BASE_URL}/api/send-broadcast`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ broadcastId: broadcast.id }),
        });
        const data = await resp.json();

        if (data.success) {
          fired++;
          console.log(`[run-broadcasts] Sent "${broadcast.name}" — ${data.sent} recipients`);
        } else {
          throw new Error(data.error || 'Send failed');
        }
      } catch (err) {
        await logError('run-broadcasts', err, { broadcastId: broadcast.id, name: broadcast.name });
        errors.push({ id: broadcast.id, error: err.message });
      }
    }

  await logActivity('broadcast_sent','Broadcast message sent',{broadcastId:req.body?.broadcastId});
    return res.status(200).json({ success: true, fired, errors: errors.length ? errors : undefined });

  } catch (err) {
    await logError('run-broadcasts', err, {});
    return res.status(500).json({ error: err.message });
  }
}
