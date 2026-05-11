// /api/manual-send-cleaner-job
//
// Sends a "you've been booked for this job" SMS to every cleaner
// assigned to the appointment (cleaner_id, cleaner_id_2, cleaner_id_3).
// Used when Dane has just assigned a cleaner via the modal and wants
// to let them know now, rather than waiting for the day-before
// reminder cron.
//
// Distinct wording from the day-before reminder — frames the message
// as "new assignment" rather than "tomorrow."
//
// On success: writes appointments.cleaner_notified_at + _by, logs
// activity. The audit timestamp reflects when ANY cleaner was last
// pinged (not per-cleaner) — keeps the column count under control.

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

const BASE_URL = 'https://hnc-crm.vercel.app';
const ADMIN_PHONE = '+18084685356';

async function logActivity(action, description, metadata = {}) {
  try {
    await fetch(process.env.SUPABASE_URL + '/rest/v1/activity_logs', {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ action, description, user_email: 'system', entity_type: action, metadata }),
    });
  } catch (_) { /* non-blocking */ }
}

function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^0-9+]/g, '');
  return '+1' + s.replace(/\D/g, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHdr = req.headers.authorization || '';
  const tokenStr = authHdr.replace('Bearer ', '').trim();
  if (!tokenStr) return res.status(401).json({ error: 'Unauthorized' });
  const authCheck = await fetchWithTimeout(
    process.env.SUPABASE_URL + '/auth/v1/user',
    { headers: { 'Authorization': 'Bearer ' + tokenStr, 'apikey': process.env.SUPABASE_ANON_KEY } },
    5000
  );
  if (!authCheck.ok) return res.status(401).json({ error: 'Unauthorized' });
  const authUser = await authCheck.json().catch(() => ({}));
  const userId = authUser?.id || null;
  const userEmail = authUser?.email || 'unknown';

  const invalid = validateOrFail(req.body, SCHEMAS.manualSendCleanerJob);
  if (invalid) return res.status(400).json(invalid);
  const { appointmentId } = req.body;
  // Mode controls the message wording. 'assigned' (default) frames it
  // as "You have been assigned: ..."; 'rescheduled' frames it as
  // "Schedule update: ... has been moved to ...". Same data, same
  // recipients, same audit column — just different text.
  const mode = req.body.mode === 'rescheduled' ? 'rescheduled' : 'assigned';

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // Pull all 3 possible cleaner ids and the appointment details.
    // No PostgREST embed for paired cleaners (the join only works for
    // the primary cleaner_id), so resolve names + phones in a second
    // round trip. cleaner_pay / _2 / _3 are pulled here so each
    // cleaner's SMS shows their own pay (paired cleaners may have
    // different rates).
    const { data: appt, error: apptErr } = await db
      .from('appointments')
      .select(`
        id, date, time, service, address, duration_hours, total_price, notes, cleaner_notes,
        client_id, cleaner_id, cleaner_id_2, cleaner_id_3,
        cleaner_pay, cleaner_pay_2, cleaner_pay_3,
        clients ( name )
      `)
      .eq('id', appointmentId)
      .maybeSingle();
    if (apptErr) throw apptErr;
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const cleanerIds = [appt.cleaner_id, appt.cleaner_id_2, appt.cleaner_id_3].filter(Boolean);
    if (cleanerIds.length === 0) {
      return res.status(400).json({
        error: 'No cleaner is assigned to this appointment yet. Assign one first, then send.',
      });
    }

    const { data: cleaners, error: clErr } = await db
      .from('cleaners')
      .select('id, name, phone')
      .in('id', cleanerIds);
    if (clErr) throw clErr;
    const eligibleCleaners = (cleaners || []).filter((c) => c.phone);
    if (eligibleCleaners.length === 0) {
      return res.status(400).json({
        error: 'Assigned cleaner(s) have no phone on file. Add a phone to the cleaner record first.',
      });
    }

    // Map each cleaner id to their slot's pay so per-cleaner messages
    // include the correct dollar figure. Slot 1 = primary, 2 = paired,
    // 3 = third paired.
    const payByCleanerId = {};
    if (appt.cleaner_id)   payByCleanerId[appt.cleaner_id]   = appt.cleaner_pay;
    if (appt.cleaner_id_2) payByCleanerId[appt.cleaner_id_2] = appt.cleaner_pay_2;
    if (appt.cleaner_id_3) payByCleanerId[appt.cleaner_id_3] = appt.cleaner_pay_3;

    const prettyDate = (() => {
      try {
        return new Date(appt.date + 'T12:00:00').toLocaleDateString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
        });
      } catch (_) { return appt.date; }
    })();
    const clientName = (appt.clients && appt.clients.name) || 'Client';
    const duration = appt.duration_hours ? `~${Math.round(appt.duration_hours)} hrs` : null;

    const buildMsg = (cleaner) => {
      const pay = payByCleanerId[cleaner.id];
      const payLine = (pay != null && !isNaN(Number(pay))) ? `Pay: $${Number(pay).toFixed(2)}` : null;
      const partners = eligibleCleaners
        .filter((c) => c.id !== cleaner.id)
        .map((c) => c.name)
        .join(', ');
      // Notes for the cleaner — prefer the new cleaner_notes field
      // (per 2026-05-10 split). Fall back to the legacy `notes` column
      // for appointments created before the split. Cap at 200 chars to
      // keep the SMS in 1-2 segments. Empty / NULL → omit the line.
      const rawCleanerNotes = (appt.cleaner_notes || appt.notes || '').trim();
      const notesLine = rawCleanerNotes
        ? `Notes: ${rawCleanerNotes.length > 200 ? rawCleanerNotes.slice(0, 197) + '...' : rawCleanerNotes}`
        : null;
      const baseLines = [
        `Client: ${clientName}`,
        appt.address ? `Address: ${appt.address}` : null,
        duration ? `Duration: ${duration}` : null,
        payLine,
        partners ? `Paired with: ${partners}` : null,
        notesLine,
        `Questions? Text Dane at ${ADMIN_PHONE}`,
      ].filter(Boolean);
      const headline = mode === 'rescheduled'
        ? `Schedule update: ${clientName}'s ${appt.service || 'cleaning'} has been rescheduled to ${prettyDate} at ${appt.time || ''}`
        : `You have been assigned: ${appt.service || 'Cleaning'} on ${prettyDate} at ${appt.time || ''}`;
      return [headline, ...baseLines].join('\n');
    };

    const results = [];
    for (const cleaner of eligibleCleaners) {
      const phone = toE164(cleaner.phone);
      try {
        const r = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: phone, message: buildMsg(cleaner) }),
        }, TIMEOUTS.OPENPHONE);
        if (!r.ok) {
          const body = await r.text().catch(() => '<unreadable>');
          await logError('manual-send-cleaner-job', new Error('send-sms ' + r.status), {
            appointmentId, cleanerId: cleaner.id, status: r.status, body: body.slice(0, 300),
          });
          results.push({ cleanerId: cleaner.id, name: cleaner.name, phone, ok: false, status: r.status });
        } else {
          results.push({ cleanerId: cleaner.id, name: cleaner.name, phone, ok: true });
        }
      } catch (err) {
        await logError('manual-send-cleaner-job', err, { appointmentId, cleanerId: cleaner.id });
        results.push({ cleanerId: cleaner.id, name: cleaner.name, phone, ok: false, error: err.message });
      }
    }

    const anyOk = results.some((r) => r.ok);
    if (!anyOk) {
      return res.status(502).json({
        error: 'Could not notify any cleaner. See Recent Errors.',
        results,
      });
    }

    const sentAt = new Date().toISOString();
    const { error: updErr } = await db
      .from('appointments')
      .update({ cleaner_notified_at: sentAt, cleaner_notified_by: userId })
      .eq('id', appointmentId);
    if (updErr) await logError('manual-send-cleaner-job:audit-update', updErr, { appointmentId });

    await logActivity(
      'manual_cleaner_job_sent',
      `${userEmail} manually sent ${mode === 'rescheduled' ? 'reschedule notice' : 'job assignment'} to ${results.filter((r) => r.ok).map((r) => r.name).join(', ')}`,
      { appointmentId, mode, results, sentBy: userId },
    );

    return res.status(200).json({ success: true, sentAt, results });
  } catch (err) {
    await logError('manual-send-cleaner-job', err, { appointmentId });
    return res.status(500).json({ error: 'Could not send cleaner job notification. See Recent Errors.' });
  }
}
