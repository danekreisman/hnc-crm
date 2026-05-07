import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';
import { generateCallBrief } from './utils/generate-brief.js';

async function logActivity(action, description, metadata={}) {
  try {
    await fetch(process.env.SUPABASE_URL+'/rest/v1/activity_logs',{
      method:'POST',
      headers:{'apikey':process.env.SUPABASE_SERVICE_ROLE_KEY,'Authorization':'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({action,description,user_email:'system',entity_type:action,metadata})
    });
  } catch(_){}
}


const HNC_BUSINESS_PHONE = '(808) 468-5356';

export default async function handler(req, res) {
  // Only allow POST from Vercel cron or internal calls
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const BASE_URL = 'https://hnc-crm.vercel.app';
  const now = new Date();
  const executionId = `exec-${Date.now()}`;

  try {
    console.log(`[${executionId}] Starting automation execution at ${now.toISOString()}`);

    // ============================================================================
    // 1. GET ALL ENABLED AUTOMATIONS
    // ============================================================================
    const { data: automations, error: autoError } = await db
      .from('lead_automations')
      .select('*')
      .eq('is_enabled', true);

    if (autoError) throw new Error(`Failed to fetch automations: ${autoError.message}`);
    if (!automations || automations.length === 0) {
      console.log(`[${executionId}] No enabled automations found`);
      
  // Post-clean review request SMS
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const reviewAppts = await fetch(`${process.env.SUPABASE_URL}/rest/v1/appointments?select=id,client_id,service,date&status=eq.completed&review_requested_at=is.null&date=gte.${yesterday}&date=lte.${today}&order=date.desc`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
    }).then(r => r.json());

    let reviewsSent = 0;
    for (const appt of (reviewAppts || [])) {
      if (!appt.client_id) continue;
      const clientData = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?select=name,phone&id=eq.${appt.client_id}`, {
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
      }).then(r => r.json());
      const client = clientData?.[0];
      if (!client?.phone) continue;

      const firstName = (client.name || '').split(' ')[0] || 'there';
      const msg = `Hi ${firstName}! We hope your Hawaii Natural Clean visit went great. If you have a moment, we would love a review: https://g.page/r/hawaiinaturalclean 🌺 Reply STOP to opt out.`;

      await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || 'https://hnc-crm.vercel.app'}/api/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: client.phone, message: msg })
      });

      // Mark review as requested
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/appointments?id=eq.${appt.id}`, {
        method: 'PATCH',
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ review_requested_at: new Date().toISOString() })
      });
      reviewsSent++;
    }
    console.log(`[post-clean] Sent ${reviewsSent} review request SMS(es)`);
  } catch (reviewErr) {
    console.error('[post-clean] Review SMS error:', reviewErr.message);
  }

  return res.status(200).json({ success: true, executedCount: 0, message: 'No automations to run' });
    }

    console.log(`[${executionId}] Found ${automations.length} enabled automations`);

    let totalExecuted = 0;
    let errors = [];

    // ============================================================================
    // 2. PROCESS EACH AUTOMATION
    // ============================================================================
    for (const automation of automations) {
      try {
        const { trigger_type, trigger_config, actions, id: automationId } = automation;

        console.log(`[${executionId}] Processing automation: ${automation.name} (${automationId})`);

        let matchingLeads = [];

        // --------------------------------------------------------------------
        // TRIGGER 1: form_submission (newly submitted leads from specific source)
        // --------------------------------------------------------------------
        if (trigger_type === 'form_submission') {
          const sourceId = trigger_config?.source_id;
          if (sourceId) {
            const { data, error } = await db
              .from('leads')
              .select('id')
              .eq('source_id', sourceId)
              .eq('segment', 'new_lead')
              .is('last_automation_run_at', null)
              .limit(50);

            if (!error) matchingLeads = data || [];
          }
        }

        // --------------------------------------------------------------------
        // TRIGGER 2: lead_created (any new lead)
        // --------------------------------------------------------------------
        if (trigger_type === 'lead_created') {
          const { data, error } = await db
            .from('leads')
            .select('id')
            .eq('segment', 'new_lead')
            .is('last_automation_run_at', null)
            .limit(50);

          if (!error) matchingLeads = data || [];
        }

        // --------------------------------------------------------------------
        // TRIGGER 3: scheduled (runs at specific time)
        // --------------------------------------------------------------------
        if (trigger_type === 'scheduled') {
          const timeOfDay = trigger_config?.time_of_day; // "09:00"
          const days = trigger_config?.days || ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

          // Check if current time matches (with 1-hour buffer)
          const currentHour = now.getHours();
          const [scheduleHour] = timeOfDay?.split(':') || [];
          const shouldRun = Math.abs(currentHour - parseInt(scheduleHour)) <= 1 && days.length > 0;

          if (shouldRun) {
            // Find leads in the target segment that haven't run this automation today
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const targetSegment = trigger_config?.segment || 'nurture';

            const { data, error } = await db
              .from('leads')
              .select('id')
              .eq('segment', targetSegment)
              .or(`last_automation_run_at.is.null,last_automation_run_at.lt.${oneDayAgo.toISOString()}`)
              .limit(50);

            if (!error) matchingLeads = data || [];
          }
        }

        // --------------------------------------------------------------------
        // TRIGGER 4: days_since_response (X days with no response)
        // --------------------------------------------------------------------
        if (trigger_type === 'days_since_response') {
          const days = trigger_config?.days || 7;
          const thresholdDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

          const { data, error } = await db
            .from('leads')
            .select('id')
            .eq('segment', 'initial_sequence')
            .lt('last_responded_at', thresholdDate.toISOString())
            .limit(50);

          if (!error) matchingLeads = data || [];
        }

        // --------------------------------------------------------------------
        // TRIGGER 5: days_in_segment (X days since moved into segment)
        // Used for: nurture sequences, one-time re-engagement, canceled win-back.
        // Checks BOTH the leads and clients tables, so canceled clients fire the
        // canceled sequence just like canceled leads would.
        // Blacklisted records (do_not_contact = true) are always skipped.
        // --------------------------------------------------------------------
        if (trigger_type === 'days_in_segment') {
          const targetSegment = trigger_config?.segment;
          const days = trigger_config?.days;
          if (targetSegment && typeof days === 'number') {
            const lowerBound = new Date(now.getTime() - (days + 1) * 24 * 60 * 60 * 1000);
            const upperBound = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

            // Query leads
            const leadsRes = await db
              .from('leads')
              .select('id')
              .eq('segment', targetSegment)
              .eq('do_not_contact', false)
              .gte('segment_moved_at', lowerBound.toISOString())
              .lt('segment_moved_at',  upperBound.toISOString())
              .limit(50);

            // Query clients that are in the matching segment
            const clientsRes = await db
              .from('clients')
              .select('id, phone, email, name')
              .eq('segment', targetSegment)
              .eq('do_not_contact', false)
              .gte('segment_moved_at', lowerBound.toISOString())
              .lt('segment_moved_at',  upperBound.toISOString())
              .limit(50);

            // For each matching client, find or create their lead record so the
            // existing lead-based execution flow works uniformly. We match by
            // phone first, then email.
            const clientLeadIds = [];
            for (const c of (clientsRes.data || [])) {
              let leadRow = null;
              if (c.phone) {
                const { data: byPhone } = await db
                  .from('leads').select('id').eq('phone', c.phone).limit(1);
                if (byPhone && byPhone[0]) leadRow = byPhone[0];
              }
              if (!leadRow && c.email) {
                const { data: byEmail } = await db
                  .from('leads').select('id').eq('email', c.email).limit(1);
                if (byEmail && byEmail[0]) leadRow = byEmail[0];
              }
              if (leadRow) clientLeadIds.push({ id: leadRow.id });
            }

            matchingLeads = [...(leadsRes.data || []), ...clientLeadIds];
          }
        }

        // --------------------------------------------------------------------
        // TRIGGER 6: stage_entered (lead entered a specific stage, optional delay)
        // --------------------------------------------------------------------
        // Polls lead_stage_events for unprocessed entries matching the
        // configured stage where the delay window has elapsed. Idempotency
        // is per-(automation, event) — same lead can re-enter the same stage
        // and re-trigger because each entry produces a distinct event row.
        let stageEventMap = null; // event-id by lead-id for stamping the run record below
        if (trigger_type === 'stage_entered') {
          const targetStage = trigger_config?.stage;
          const delayMinutes = Number(trigger_config?.delay_minutes) || 0;
          if (targetStage) {
            // Compute the cutoff: only events whose occurred_at + delay <= now
            // are eligible.
            const cutoff = new Date(now.getTime() - delayMinutes * 60 * 1000).toISOString();

            // Pull candidate unprocessed events for this stage in the
            // delay-elapsed window. We scan a 90-day window — anything older
            // is treated as expired (covers reactivation cadences up to 90
            // days; longer cadences should be split into multiple automations
            // OR we extend this window in a future phase).
            const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

            const { data: events, error: evErr } = await db
              .from('lead_stage_events')
              .select('id, lead_id, occurred_at')
              .eq('to_stage', targetStage)
              .is('processed_at', null)
              .gte('occurred_at', ninetyDaysAgo)
              .lte('occurred_at', cutoff)
              .order('occurred_at', { ascending: true })
              .limit(100);

            if (evErr) {
              console.warn(`[${executionId}] stage_entered query failed:`, evErr.message);
            } else if (events && events.length) {
              // Per-(automation, event) idempotency: drop events that already
              // have a run row for this automation. We do this in one round
              // trip rather than per-event checks below.
              const eventIds = events.map(e => e.id);
              const { data: alreadyRun } = await db
                .from('lead_automation_runs')
                .select('stage_event_id')
                .eq('automation_id', automationId)
                .in('stage_event_id', eventIds);
              const alreadyRunSet = new Set((alreadyRun || []).map(r => r.stage_event_id));

              let fresh = events.filter(e => !alreadyRunSet.has(e.id));

              // ── Tide Phase 2 (2026-05-07): current-stage gate + service_type filter ──
              // The lead_stage_events table is append-only history. Without a
              // current-stage check, a lead who entered Quoted on Day 0, then
              // got moved to Closed lost on Day 4, would still receive the
              // Day 5+ touches because the original 'Quoted' event still
              // exists. We don't want stale-cadence fires.
              //
              // Optional service_type filter: trigger_config.service_type, when
              // set, restricts firing to leads whose `service` field matches
              // (case-insensitive). This is what makes the Tide Quoted variants
              // (Move-Out / Deep Clean / Regular) work — same stage, different
              // cadences, branched by service.
              //
              // Both checks consolidated into one round trip to leads.
              if (fresh.length) {
                const targetServiceType = trigger_config?.service_type || null;
                const leadIds = fresh.map(e => e.lead_id);
                const { data: leadRows } = await db
                  .from('leads')
                  .select('id, stage, service')
                  .in('id', leadIds);
                const matchingSet = new Set(
                  (leadRows || [])
                    .filter(l => l.stage === targetStage)
                    .filter(l => !targetServiceType ||
                      (l.service || '').toLowerCase() === targetServiceType.toLowerCase())
                    .map(l => l.id)
                );
                fresh = fresh.filter(e => matchingSet.has(e.lead_id));
              }

              matchingLeads = fresh.map(e => ({ id: e.lead_id }));
              // Build a map so the run record below can be stamped with the
              // event id (enables future audit / debug queries).
              stageEventMap = new Map(fresh.map(e => [e.lead_id, e.id]));
            }
          }
        }

        // Blacklist guard: re-filter matchingLeads to drop any do_not_contact leads
        // (for trigger types that didn't filter upstream)
        if (matchingLeads.length > 0) {
          const ids = matchingLeads.map(l => l.id);
          const { data: allowedRows } = await db
            .from('leads')
            .select('id')
            .in('id', ids)
            .eq('do_not_contact', false)
          .is('unsubscribed_at', null);
          const allowedSet = new Set((allowedRows || []).map(r => r.id));
          matchingLeads = matchingLeads.filter(l => allowedSet.has(l.id));
        }

        console.log(`[${executionId}] Found ${matchingLeads.length} matching leads for trigger: ${trigger_type}`);

        // ============================================================================
        // 3. EXECUTE ACTIONS FOR EACH MATCHING LEAD
        // ============================================================================
        for (const lead of matchingLeads) {
          try {
            const leadId = lead.id;

            // Legacy 24h idempotency check applies to all triggers EXCEPT
            // stage_entered (which uses per-(automation, stage_event_id)
            // idempotency upstream — same lead can re-enter the same stage
            // and re-fire). Skipping the legacy check for stage_entered
            // also lets multiple stage_entered automations on the same lead
            // fire in the same cron tick without spurious skips.
            if (trigger_type !== 'stage_entered') {
              const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
              const { data: existingRun } = await db
                .from('lead_automation_runs')
                .select('id')
                .eq('automation_id', automationId)
                .eq('lead_id', leadId)
                .gte('started_at', oneDayAgo.toISOString())
                .limit(1);

              if (existingRun && existingRun.length > 0) {
                console.log(`[${executionId}] Skipping lead ${leadId} - automation already ran today`);
                continue;
              }
            }

            // Get full lead data
            const { data: leadData } = await db
              .from('leads')
              .select('*')
              .eq('id', leadId)
              .single();

            if (!leadData) continue;

            // Compute once per lead — available to both SMS and email AI personalization
            const bookingUrlForLead = leadData.booking_token
              ? `${BASE_URL}/book.html?bt=${leadData.booking_token}`
              : null;

            console.log(`[${executionId}] Executing ${actions?.length || 0} actions for lead: ${leadData.name}`);

            // Track execution. For stage_entered triggers, stamp the source
            // event id so the upstream idempotency query can see this run.
            const stageEventIdForRun = stageEventMap ? stageEventMap.get(leadId) : null;
            const { data: runRecord } = await db
              .from('lead_automation_runs')
              .insert([{
                automation_id: automationId,
                lead_id: leadId,
                trigger_data: trigger_config,
                status: 'running',
                started_at: now.toISOString(),
                stage_event_id: stageEventIdForRun || null,
              }])
              .select()
              .single();

            const runId = runRecord?.id;
            let actionsExecuted = [];

            // --------------------------------------------------------------------
            // EXECUTE EACH ACTION IN SEQUENCE
            // --------------------------------------------------------------------
            for (let i = 0; i < (actions?.length || 0); i++) {
              const action = actions[i];
              const actionStartTime = new Date();

              try {
                // Handle delay before action
                if (action.delay_minutes && action.delay_minutes > 0) {
                  // Skip if not enough time has passed since automation started
                  const delayMs = action.delay_minutes * 60 * 1000;
                  const elapsedMs = actionStartTime.getTime() - now.getTime();
                  if (elapsedMs < delayMs) {
                    console.log(`[${executionId}] Delaying action ${i} for ${action.delay_minutes} minutes`);
                    continue; // Skip this action, will run next cycle
                  }
                }

                if (action.type === 'sms') {
                  let message = substituteVars(action.message, leadData);

                  // Optionally personalize with AI using call/SMS history
                  if (action.ai_personalize) {
                    try {
                      const aiRes = await fetch(`${BASE_URL}/api/ai-personalize`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          template: message,
                          channel: 'sms',
                          leadId: leadData.id,
                          purpose: automation.name,
                          bookingUrl: bookingUrlForLead,
                          businessPhone: HNC_BUSINESS_PHONE,
                        })
                      });
                      const aiData = await aiRes.json();
                      if (aiData?.message && aiData.personalized) {
                        message = aiData.message;
                        console.log(`[${executionId}] AI personalized SMS for ${leadData.name}`);
                      }
                    } catch (aiErr) {
                      await logError('run-automations', aiErr, { stage: 'ai_personalize_sms', leadId: leadData.id });
                      console.warn(`[${executionId}] AI personalize failed, using template:`, aiErr.message);
                    }
                  }

                  const phone = leadData.phone;

                  const smsRes = await fetch(`${BASE_URL}/api/send-sms`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to: phone, message })
                  });

                  const smsStatus = smsRes.status === 200 ? 'success' : 'failed';
                  actionsExecuted.push({
                    action_index: i,
                    type: 'sms',
                    status: smsStatus,
                    message: message.substring(0, 100),
                    executed_at: actionStartTime.toISOString()
                  });

                  console.log(`[${executionId}] SMS action ${i}: ${smsStatus}`);
                }

                if (action.type === 'email') {
                  let emailBody = substituteVars(action.message || '', leadData);

                  // Optionally personalize with AI using call/SMS history
                  if (action.ai_personalize) {
                    try {
                      const aiRes = await fetch(`${BASE_URL}/api/ai-personalize`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          template: emailBody,
                          channel: 'email',
                          leadId: leadData.id,
                          purpose: automation.name,
                          bookingUrl: bookingUrlForLead,
                          businessPhone: HNC_BUSINESS_PHONE,
                        })
                      });
                      const aiData = await aiRes.json();
                      if (aiData?.message && aiData.personalized) {
                        emailBody = aiData.message;
                        console.log(`[${executionId}] AI personalized email for ${leadData.name}`);
                      }
                    } catch (aiErr) {
                      await logError('run-automations', aiErr, { stage: 'ai_personalize_email', leadId: leadData.id });
                      console.warn(`[${executionId}] AI personalize failed, using template:`, aiErr.message);
                    }
                  }

                  const emailRes = await fetch(`${BASE_URL}/api/send-email`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      to: leadData.email,
                      subject: substituteVars(action.subject || 'A note from Hawaii Natural Clean', leadData),
                      type: 'generic',
                      clientName: leadData.contact_name || leadData.name,
                      notes: emailBody,
                      bookingUrl: bookingUrlForLead,
                      unsubscribeUrl: `${BASE_URL}/api/unsubscribe?id=${leadData.id}&type=lead`,
                    })
                  });

                  const emailStatus = emailRes.status === 200 ? 'success' : 'failed';
                  actionsExecuted.push({
                    action_index: i,
                    type: 'email',
                    status: emailStatus,
                    executed_at: actionStartTime.toISOString()
                  });

                  console.log(`[${executionId}] Email action ${i}: ${emailStatus}`);
                }

                if (action.type === 'segment_move') {
                  await db
                    .from('leads')
                    .update({
                      segment: action.new_segment,
                      segment_moved_at: actionStartTime.toISOString()
                    })
                    .eq('id', leadId);

                  actionsExecuted.push({
                    action_index: i,
                    type: 'segment_move',
                    new_segment: action.new_segment,
                    status: 'success',
                    executed_at: actionStartTime.toISOString()
                  });

                  console.log(`[${executionId}] Moved lead to segment: ${action.new_segment}`);
                }

                if (action.type === 'create_va_task') {
                  // Create a VA task linked to the lead. Schema mirrors
                  // run-task-automations.js — same `tasks` table, same fields.
                  // The {firstName}, {service}, {stage} placeholders in title
                  // and description are interpolated from the lead.
                  //
                  // Tide Phase 4 (2026-05-07): also generates an AI brief
                  // (lead context: call/SMS history signals, talking points)
                  // and stores it on the task's `ai_brief` field. The UI
                  // renders ai_brief as a collapsible "✨ AI brief" panel
                  // below the description on each task. The brief generation
                  // is fail-soft — if it fails or is skipped, the task still
                  // gets created without the brief (just no extra context).
                  //
                  // To skip brief generation for a specific automation (e.g.
                  // a lead-stale internal-notification task that doesn't
                  // benefit from history), set `action.skip_ai_brief: true`.
                  try {
                    const firstName = (lead.name || lead.contact_name || 'Lead').split(' ')[0];
                    const interpolate = (s) => (s || '')
                      .replaceAll('{firstName}', firstName)
                      .replaceAll('{name}', lead.name || lead.contact_name || 'Lead')
                      .replaceAll('{service}', lead.service || 'cleaning')
                      .replaceAll('{stage}', lead.stage || '');
                    const todayIso = new Date().toISOString().slice(0, 10);

                    // Generate AI brief (fail-soft — null on any error or if skipped)
                    let aiBrief = null;
                    if (!action.skip_ai_brief) {
                      const briefPurpose = action.brief_purpose || briefPurposeForStage(lead.stage);
                      try {
                        aiBrief = await generateCallBrief(lead, briefPurpose);
                      } catch (briefErr) {
                        // generateCallBrief is itself fail-soft; this catch is
                        // a defensive belt-and-suspenders so a brief failure
                        // never blocks task creation.
                        await logError('run-automations', briefErr, {
                          stage: 'ai_brief_generation',
                          leadId: lead.id,
                          purpose: briefPurpose,
                        });
                      }
                    }

                    const { error: taskErr } = await db.from('tasks').insert([{
                      title: interpolate(action.title) || `Follow up with ${firstName}`,
                      type: action.task_type || 'call_lead',
                      priority: action.priority || 'high',
                      due_date: todayIso,
                      description: interpolate(action.description) || '',
                      related_lead_id: lead.id,
                      status: 'open',
                      ai_brief: aiBrief,
                      // Tide Phase 5 (2026-05-07): structured one-tap-send payload.
                      // When the action carries a suggested_message + channel,
                      // copy them onto the task so the UI can render a Send
                      // button without regex-parsing the description.
                      suggested_message: action.suggested_message ? interpolate(action.suggested_message) : null,
                      suggested_channel: action.suggested_channel || null,
                    }]);
                    if (taskErr) throw taskErr;
                    actionsExecuted.push({
                      action_index: i,
                      type: 'create_va_task',
                      status: 'success',
                      brief_attached: !!aiBrief,
                      executed_at: actionStartTime.toISOString()
                    });
                  } catch (vaErr) {
                    actionsExecuted.push({
                      action_index: i,
                      type: 'create_va_task',
                      status: 'failed',
                      error: vaErr.message,
                      executed_at: actionStartTime.toISOString()
                    });
                  }
                }
                if (action.type === 'internal_notification') {
                  // Log for now (could integrate with Slack/email later)
                  console.log(`[${executionId}] Internal notification: ${action.message}`);
                  actionsExecuted.push({
                    action_index: i,
                    type: 'internal_notification',
                    status: 'success',
                    executed_at: actionStartTime.toISOString()
                  });
                }
              } catch (actionError) {
                console.error(`[${executionId}] Action ${i} error:`, actionError.message);
                actionsExecuted.push({
                  action_index: i,
                  type: action.type,
                  status: 'failed',
                  error: actionError.message,
                  executed_at: actionStartTime.toISOString()
                });
              }
            }

            // Update run record with results
            await db
              .from('lead_automation_runs')
              .update({
                status: 'success',
                actions_executed: actionsExecuted,
                completed_at: new Date().toISOString()
              })
              .eq('id', runId);

            // Mark that this automation ran on this lead
            await db
              .from('leads')
              .update({ last_automation_run_at: now.toISOString() })
              .eq('id', leadId);

            totalExecuted++;
            try { await logActivity('automation_fired', (automation.name || 'Automation') + ' -> ' + (lead.name || lead.contact_name || 'Lead'), { automationId: automation.id, leadId: lead.id }); } catch (_le) {}
          } catch (leadError) {
            console.error(`[${executionId}] Error executing automation for lead:`, leadError.message);
          }
        }
      } catch (automationError) {
        console.error(`[${executionId}] Error processing automation:`, automationError.message);
        errors.push({
          automationId: automation.id,
          error: automationError.message
        });
      }
    }

    

  console.log(`[${executionId}] Completed. Executed ${totalExecuted} lead automations`);

    return res.status(200).json({
      success: true,
      executedCount: totalExecuted,
      errors: errors.length > 0 ? errors : undefined,
      executionId
    });
  } catch (error) {
    console.error(`[${executionId}] Fatal error:`, error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      executionId
    });
  }
}

// Helper: substitute variables in message templates
function substituteVars(template, leadData) {
  if (!template) return '';
  const firstName = leadData.contact_name?.split(' ')[0] || leadData.name?.split(' ')[0] || 'there';

  return template
    .replace(/\{firstName\}/g, firstName)
    .replace(/\{name\}/g, leadData.name)
    .replace(/\{service\}/g, leadData.service || 'cleaning')
    .replace(/\{frequency\}/g, leadData.frequency || '')
    .replace(/\{address\}/g, leadData.address || '')
    .replace(/\{quote_total\}/g, leadData.quote_total || 'custom')
    .replace(/\{phone\}/g, HNC_BUSINESS_PHONE);
}

// Helper: pick the right brief-purpose hint based on a lead's stage. Used by
// the create_va_task handler so the AI brief is framed appropriately for the
// lifecycle moment (a Closed-lost dripback brief reads very differently from
// a New-inquiry follow-up brief). Override per-action with action.brief_purpose
// if a Tide row needs something more specific.
function briefPurposeForStage(stage) {
  switch (stage) {
    case 'New inquiry':           return 'tide_inquiry_followup';
    case 'Quoted':                return 'tide_quoted_followup';
    case 'Walkthrough requested': return 'tide_walkthrough_confirm';
    case 'Closed lost':           return 'tide_lost_dripback';
    case 'Long-Term Follow-Up':   return 'tide_inquiry_followup';
    default:                      return stage ? `${stage} follow-up` : 'general follow-up';
  }
}
