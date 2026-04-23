/**
 * POST /api/run-job-completions  (called by Vercel cron, hourly)
 *
 * Finds appointments where the estimated end time has passed and
 * status is still 'scheduled' or 'assigned', then marks them 'completed'.
 *
 * Estimated end time = appointment date + start time + duration_hours
 * Appointments without duration_hours are skipped.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const now = new Date();

    // Fetch all scheduled/assigned appointments that have a duration
    const { data: appointments, error } = await db
      .from('appointments')
      .select('id, date, time, duration_hours, status')
      .in('status', ['scheduled', 'assigned'])
      .not('duration_hours', 'is', null)
      .lte('date', now.toISOString().split('T')[0]); // only today or past

    if (error) throw error;
    if (!appointments || appointments.length === 0) {
      return res.status(200).json({ success: true, completed: 0, message: 'No appointments to complete' });
    }

    const toComplete = [];

    for (const appt of appointments) {
      // Parse "9:00 AM" → hour/minute in local time (Hawaii = UTC-10)
      const [timePart, meridiem] = appt.time.split(' ');
      let [hours, minutes] = timePart.split(':').map(Number);
      if (meridiem === 'PM' && hours !== 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;

      // Build estimated end time in UTC (Hawaii is UTC-10)
      const startUtc = new Date(`${appt.date}T00:00:00Z`);
      startUtc.setUTCHours(hours + 10, minutes, 0, 0); // +10 to convert HST→UTC
      const endUtc = new Date(startUtc.getTime() + appt.duration_hours * 60 * 60 * 1000);

      if (now >= endUtc) {
        toComplete.push(appt.id);
      }
    }

    if (toComplete.length === 0) {
      return res.status(200).json({ success: true, completed: 0, message: 'No appointments past end time yet' });
    }

    const { error: updateErr } = await db
      .from('appointments')
      .update({ status: 'completed' })
      .in('id', toComplete);

    if (updateErr) throw updateErr;

    console.log(`[run-job-completions] Marked ${toComplete.length} appointment(s) as completed`);
    return res.status(200).json({ success: true, completed: toComplete.length, ids: toComplete });

  } catch (err) {
    await logError('run-job-completions', err, {});
    return res.status(500).json({ error: err.message });
  }
}
