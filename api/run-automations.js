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

            // Check if automation already ran for this lead today
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

            // Track execution
            const { data: runRecord } = await db
              .from('lead_automation_runs')
              .insert([{
                automation_id: automationId,
                lead_id: leadId,
                trigger_data: trigger_config,
                status: 'running',
                started_at: now.toISOString(),
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
