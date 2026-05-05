/**
 * POST /api/accept-call-lead
 *
 * Called from the `review_call_lead` task review modal in the CRM. Takes
 * the (possibly Dane-edited) lead fields, creates the lead in the leads
 * table, registers the phone as an OpenPhone contact, and marks the task
 * complete. Returns the new lead's id.
 *
 * Body:
 *   { taskId, name, phone, email?, address?, service?, sqft?, beds?, baths?,
 *     condition?, frequency?, notes? }
 *
 * Returns:
 *   { success: true, leadId, leadRow }   on success
 *   { success: false, error }            on failure
 *
 * Auth: Bearer token, same pattern as /api/tasks.
 */

import { createClient } from '@supabase/supabase-js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth gate — same pattern as /api/tasks
  const authHdr = req.headers.authorization || '';
  const token = authHdr.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + token, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });

  // Validate input
  const invalid = validateOrFail(req.body, SCHEMAS.acceptCallLead);
  if (invalid) return res.status(400).json(invalid);

  const {
    taskId, name, phone, email, address, service, sqft, beds, baths,
    condition, frequency, notes,
  } = req.body;

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // 1. Insert the lead. Mirror the field shape used by dbSaveLead in
    //    index.html so the lead surfaces consistently in the pipeline.
    const leadInsert = {
      name: String(name).trim(),
      contact_name: String(name).trim(),
      phone: phone || null,
      email: email || null,
      address: address || null,
      service: service || null,
      sqft: sqft || null,
      beds: beds || null,
      baths: baths || null,
      condition: condition || null,
      frequency: frequency || null,
      source: 'Phone call',
      stage: 'New inquiry',
      next_action: 'Follow up',
      notes: notes || null,
      // Tracking fields used by automations + segments. New phone leads
      // start in initial_sequence so the days_since_response automation
      // can pick them up if they go cold.
      segment: 'initial_sequence',
      segment_moved_at: new Date().toISOString(),
    };

    const { data: lead, error: leadErr } = await db.from('leads').insert([leadInsert]).select().single();
    if (leadErr) throw leadErr;

    // 2. Mark the source task complete. We don't roll back the lead if this
    //    fails — better to have a duplicate-task issue than to lose the lead.
    if (taskId) {
      const { error: taskErr } = await db.from('tasks').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', taskId);
      if (taskErr) console.warn('[accept-call-lead] task update failed:', taskErr.message);
    }

    // 3. Register phone as an OpenPhone contact (mirrors web-form path).
    //    Fire-and-forget — endpoint dedupes by phone, so a slow/failing
    //    OpenPhone API doesn't block the lead-created response.
    const opUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/openphone-create-contact`;
    fetchWithTimeout(opUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: leadInsert.name,
        phone: phone,
        email: email || undefined,
        leadId: lead.id,
        company: /commercial|janitorial|government/i.test(service || '') ? (address || undefined) : undefined,
      }),
    }, TIMEOUTS.OPENPHONE)
      .then(r => r.text())
      .then(t => console.log('[accept-call-lead] openphone contact:', String(t).slice(0, 200)))
      .catch(err => console.warn('[accept-call-lead] openphone contact failed:', err.message));

    return res.status(200).json({ success: true, leadId: lead.id, leadRow: lead });
  } catch (err) {
    await logError('accept-call-lead', err, { taskId, phone });
    return res.status(500).json({ success: false, error: err.message });
  }
}
