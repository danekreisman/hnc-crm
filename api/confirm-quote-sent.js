/**
 * POST /api/confirm-quote-sent
 *
 * Called from the `review_quote_sent` task review buttons in the CRM.
 * Stamps the lead with quote_sent_at, quote_total (and bumps stage to
 * 'Quoted' if it isn't already), then closes the source task. That stamp
 * is what makes the Day-1 followup task fire from run-task-automations
 * the next morning.
 *
 * Two paths feed this task type:
 *   1. Existing-lead caller — webhook detects a verbal quote on the call
 *      transcript and creates the task directly.
 *   2. New-caller `review_call_lead` flow — quote_amount is captured in
 *      the same AI pass and accept-call-lead.js chains the task after
 *      the new lead is created.
 *
 * Both feed this same endpoint to confirm.
 *
 * Body:
 *   { taskId, leadId, amount }
 *
 * Returns:
 *   { success: true, leadRow } on success
 *   { success: false, error } on failure
 *
 * Auth: Bearer token, same pattern as /api/tasks and /api/accept-call-lead.
 */

import { createClient } from '@supabase/supabase-js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { fetchWithTimeout } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth gate — same pattern as /api/tasks and /api/accept-call-lead.
  const authHdr = req.headers.authorization || '';
  const token = authHdr.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + token, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });

  const invalid = validateOrFail(req.body, SCHEMAS.confirmQuoteSent);
  if (invalid) return res.status(400).json(invalid);

  const { taskId, leadId, amount } = req.body;
  const numericAmount = Number(amount);

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // 1. Fetch current lead to decide whether we should advance the stage.
    //    Closed won/lost stays put — confirming a historical quote shouldn't
    //    pull a closed lead back into Quoted.
    const { data: leadBefore, error: readErr } = await db
      .from('leads')
      .select('id, name, stage, quote_total, quote_data, quote_sent_at')
      .eq('id', leadId)
      .single();
    if (readErr) throw readErr;
    if (!leadBefore) throw new Error('Lead not found');

    const KEEP_STAGE = ['Closed won', 'Closed lost'];
    const nextStage = KEEP_STAGE.includes(leadBefore.stage) ? leadBefore.stage : 'Quoted';

    // 2. Stamp the lead. quote_data gets a minimal payload that mirrors the
    //    shape lead-capture.js writes — just enough for downstream surfaces
    //    (suggested-quote card, AI followup prompts) to recognize it as a
    //    real, sent quote.
    const nowIso = new Date().toISOString();
    const quoteData = {
      total: numericAmount,
      source: 'verbal_call_quote',
      confirmed_at: nowIso,
    };
    const { data: leadAfter, error: updErr } = await db
      .from('leads')
      .update({
        quote_sent_at: nowIso,
        quote_total: numericAmount,
        quote_data: quoteData,
        stage: nextStage,
      })
      .eq('id', leadId)
      .select()
      .single();
    if (updErr) throw updErr;

    // 3. Close the source task. Don't roll back the lead update if this
    //    fails — the stamp is the load-bearing change; a leftover task is
    //    a small UX nit by comparison.
    if (taskId) {
      const { error: taskErr } = await db.from('tasks').update({
        status: 'completed',
        completed_at: nowIso,
      }).eq('id', taskId);
      if (taskErr) console.warn('[confirm-quote-sent] task update failed:', taskErr.message);
    }

    return res.status(200).json({ success: true, leadRow: leadAfter });
  } catch (err) {
    await logError('confirm-quote-sent', err, { taskId, leadId, amount: numericAmount });
    return res.status(500).json({ success: false, error: err.message });
  }
}
