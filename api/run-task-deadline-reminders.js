/**
 * Daily task-deadline reminder cron.
 *
 * Schedule: 18:00 UTC = 8:00 AM Hawaii (Hawaii does not observe DST so this
 * is a stable mapping year-round).
 *
 * Behavior: finds tasks with status='open' AND due_date <= today, groups them
 * into "Overdue" (due_date < today) and "Due today" (due_date = today), and
 * sends a single SMS digest to OWNER_PHONE (the HNC business line). One SMS
 * per day max — silent if there's nothing to send.
 *
 * No kill switch — this is a simple owner-notification, low blast radius.
 * If we ever want one, gate on a new ai_booking_settings flag like
 * task_due_reminder_enabled following the pattern in automation-gate.js.
 */

import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const OWNER_PHONE  = '+18084685356'; // HNC business line — same as lead-capture.js
const QUO_API_KEY  = process.env.QUO_API_KEY;

export default async function handler(req, res) {
  try {
    // Today in Hawaii. Hawaii is UTC-10, no DST. Date arithmetic in UTC then
    // shift by -10 hours to get the local date string the cron runs in.
    const nowUtc = new Date();
    const hawaiiOffsetMs = -10 * 60 * 60 * 1000;
    const todayHawaii = new Date(nowUtc.getTime() + hawaiiOffsetMs).toISOString().split('T')[0];

    // Fetch open tasks with a due_date set, due today or before
    const taskRes = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/tasks?status=eq.open&due_date=lte.${todayHawaii}&select=id,title,due_date,priority,type,related_lead_id,related_client_id&order=due_date.asc`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      },
      8000
    );

    if (!taskRes.ok) {
      throw new Error(`Supabase fetch failed: ${taskRes.status}`);
    }

    const tasks = await taskRes.json();
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(200).json({ success: true, sent: 0, reason: 'no tasks due' });
    }

    // Bucket by overdue vs due today
    const overdue = tasks.filter(t => t.due_date && t.due_date < todayHawaii);
    const dueToday = tasks.filter(t => t.due_date === todayHawaii);

    // Build digest. Keep it short — SMS, not email.
    const lines = [];
    if (overdue.length) {
      lines.push(`\u26A0\uFE0F ${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}:`);
      overdue.slice(0, 5).forEach(t => {
        const priority = t.priority === 'high' ? ' (HIGH)' : '';
        lines.push(`\u2022 ${t.title}${priority}`);
      });
      if (overdue.length > 5) lines.push(`\u2026 +${overdue.length - 5} more`);
    }
    if (dueToday.length) {
      if (lines.length) lines.push('');
      lines.push(`\uD83D\uDCC5 ${dueToday.length} task${dueToday.length > 1 ? 's' : ''} due today:`);
      dueToday.slice(0, 5).forEach(t => {
        const priority = t.priority === 'high' ? ' (HIGH)' : '';
        lines.push(`\u2022 ${t.title}${priority}`);
      });
      if (dueToday.length > 5) lines.push(`\u2026 +${dueToday.length - 5} more`);
    }
    lines.push('');
    lines.push('See all: hnc-crm.vercel.app/tasks');

    const message = lines.join('\n');

    // Send SMS via internal /api/send-sms route
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://hnc-crm.vercel.app';

    const smsRes = await fetchWithTimeout(
      `${baseUrl}/api/send-sms`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: OWNER_PHONE, message }),
      },
      TIMEOUTS.QUO || 10000
    );

    return res.status(200).json({
      success: true,
      sent: 1,
      total_tasks: tasks.length,
      overdue: overdue.length,
      due_today: dueToday.length,
      sms_status: smsRes.status,
    });
  } catch (err) {
    await logError('run-task-deadline-reminders', err, {});
    return res.status(500).json({ error: err.message });
  }
}
