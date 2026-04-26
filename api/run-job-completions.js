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
import { getOpenPhoneHistory } from './utils/openphone-history.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';

// ── VA TASK TEST MODE: limit task creation to Dane only during rollout ─────
const TASK_AUTOMATIONS_TEST_MODE = true;
const DANE_PHONE_DIGITS = '8082697636';
const DANE_EMAIL = 'dane.kreisman@gmail.com';

function _digitsOnly(s){ return (s||'').replace(/\D/g,''); }

function isTestSafeRecord(record){
  if(!TASK_AUTOMATIONS_TEST_MODE) return true;
  if(!record) return false;
  var phoneD = _digitsOnly(record.phone);
  if(phoneD && phoneD.indexOf(DANE_PHONE_DIGITS) >= 0) return true;
  var email = (record.email||'').trim().toLowerCase();
  if(email && email === DANE_EMAIL) return true;
  return false;
}


async function isNotifEnabled(db, clientId, key) {
  if (!clientId) return true;
  const { data } = await db.from('clients').select('notification_prefs').eq('id', clientId).maybeSingle();
  const prefs = { booking_confirmation:true, day_before_reminder:true, invoice_reminder:true, policy_reminder:true, post_clean_email:true, review_request:true, ...(data?.notification_prefs || {}) };
  return prefs[key] !== false;
}

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
      .select('id, date, time, duration_hours, status, client_id')
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

    // ── First-clean task: call client immediately after first appointment ──
    const firstCleanTasks = [];
    for (const apptId of toComplete) {
      const appt = appointments.find(a => a.id === apptId);
      if (!appt?.client_id) continue;

      // Check if this is the client's first completed appointment
      const { data: prevAppts } = await db
        .from('appointments')
        .select('id')
        .eq('client_id', appt.client_id)
        .eq('status', 'completed')
        .neq('id', apptId)
        .limit(1);

      if (prevAppts && prevAppts.length > 0) continue; // not first clean

      // Check no existing call_client task for this client
      const { data: existingTask } = await db
        .from('tasks')
        .select('id')
        .eq('type', 'call_client')
        .eq('related_client_id', appt.client_id)
        .eq('status', 'open')
        .limit(1);

      if (existingTask && existingTask.length > 0) continue;

      // Fetch client info for the brief
      const { data: client } = await db
        .from('clients')
        .select('name, phone, email, pre_existing')
        .eq('id', appt.client_id)
        .single();

      if (!client) continue;

      // Skip pre-existing/imported clients — they're not actually new to the business,
      // they were just migrated into the CRM. The toggle on the booking form (default off)
      // sets pre_existing=true unless the user explicitly marks the booking as a new client.
      if (client.pre_existing === true) {
        console.log(`[run-job-completions] Skipping first-clean task: ${client.name} is pre_existing`);
        continue;
      }

      // VA-task test mode guard: only create tasks for Dane during rollout
      if (!isTestSafeRecord(client)) {
        console.log(`[run-job-completions] TEST_MODE: skipping first-clean task for ${client.name}`);
        continue;
      }

      // Generate a brief AI call note (light — no OpenPhone history needed for first clean)
      const today = new Date().toISOString().split('T')[0];
      const { error: taskErr } = await db.from('tasks').insert([{
        title: `Call ${client.name} — first clean complete`,
        type: 'call_client',
        priority: 'high',
        due_date: today,
        description: 'First clean just completed. Call to check in on quality, answer questions, and lock in a recurring schedule.',
        related_client_id: appt.client_id,
        status: 'open',
      }]);

      if (!taskErr) {
        firstCleanTasks.push(client.name);
        try {
          await fetch(process.env.SUPABASE_URL+'/rest/v1/activity_logs', {
            method:'POST',
            headers:{'apikey':process.env.SUPABASE_SERVICE_ROLE_KEY,'Authorization':'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},
            body:JSON.stringify({action:'va_task_created',description:`First-clean follow-up for ${client.name}`,user_email:'system',entity_type:'va_task_created',metadata:{task_type:'call_client', client_id:appt.client_id, automation:'post_first_appt'}})
          });
        } catch(_){}
        console.log(`[run-job-completions] Created first-clean follow-up task for ${client.name}`);
      }
    }

    // ── Post-clean thank-you email with feedback gate ─────────────────────
    for (const apptId of toComplete) {
      const appt = appointments.find(a => a.id === apptId);
      if (!appt?.client_id) continue;
      try {
        const { data: client } = await db.from('clients')
          .select('name, email')
          .eq('id', appt.client_id)
          .maybeSingle();
        if (!client?.email) continue;
        const postCleanOn = await isNotifEnabled(db, appt.client_id, 'post_clean_email');
        if (!postCleanOn) continue;
        const feedbackUrl = `https://hnc-crm.vercel.app/feedback?c=${appt.client_id}&a=${apptId}`;
        await fetch('https://hnc-crm.vercel.app/api/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: client.email,
            subject: 'How was your clean today? 🌺',
            type: 'thankyou',
            clientName: client.name,
            feedbackUrl,
          }),
        });
        console.log(`[run-job-completions] Post-clean email sent to ${client.email}`);
      } catch (emailErr) {
        console.error('[run-job-completions] Post-clean email failed:', emailErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      completed: toComplete.length,
      ids: toComplete,
      firstCleanTasks,
    });

  } catch (err) {
    await logError('run-job-completions', err, {});
    return res.status(500).json({ error: err.message });
  }
}
