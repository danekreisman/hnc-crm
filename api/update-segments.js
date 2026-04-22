import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const now = new Date();
  const executionId = `seg-${Date.now()}`;

  try {
    console.log(`[${executionId}] Starting segment detection at ${now.toISOString()}`);

    let segmentChanges = {
      initial_to_nurture: 0,
      hot_lead_to_active: 0,
      one_time_detection: 0,
      canceled_detection: 0,
      lost_detection: 0
    };

    // ============================================================================
    // 1. INITIAL_SEQUENCE → NURTURE (7+ days, no response)
    // ============================================================================
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { data: expiredInitial, error: e1 } = await db
      .from('leads')
      .select('id')
      .eq('segment', 'initial_sequence')
      .lt('created_at', sevenDaysAgo.toISOString())
      .eq('response_count', 0);

    if (!e1 && expiredInitial?.length > 0) {
      await db
        .from('leads')
        .update({
          segment: 'nurture',
          segment_moved_at: now.toISOString()
        })
        .in('id', expiredInitial.map(l => l.id));

      segmentChanges.initial_to_nurture = expiredInitial.length;
      console.log(`[${executionId}] Moved ${expiredInitial.length} leads from initial_sequence → nurture`);
    }

    // ============================================================================
    // 2. DETECT HOT LEADS (has response, hasn't been converted)
    // ============================================================================
    const { data: newHotLeads, error: e2 } = await db
      .from('leads')
      .select('id')
      .neq('segment', 'hot_lead')
      .neq('segment', 'converted')
      .neq('segment', 'blacklist')
      .gt('response_count', 0)
      .is('converted_client_id', null);

    if (!e2 && newHotLeads?.length > 0) {
      await db
        .from('leads')
        .update({
          segment: 'hot_lead',
          segment_moved_at: now.toISOString()
        })
        .in('id', newHotLeads.map(l => l.id));

      segmentChanges.hot_lead_to_active = newHotLeads.length;
      console.log(`[${executionId}] Detected ${newHotLeads.length} hot leads`);
    }

    // ============================================================================
    // 3. ONE-TIME CUSTOMER DETECTION (booked once, X days since booking completed)
    // ============================================================================
    // Find customers with 1 booking and last booking was 3+ days ago
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    const { data: oneTimeCustomers, error: e3 } = await db
      .from('leads')
      .select('id, last_booking_date')
      .eq('booking_count_6m', 1)
      .neq('segment', 'one_time')
      .neq('segment', 'reengagement')
      .lt('last_booking_date', threeDaysAgo.toISOString());

    if (!e3 && oneTimeCustomers?.length > 0) {
      await db
        .from('leads')
        .update({
          segment: 'one_time',
          segment_moved_at: now.toISOString()
        })
        .in('id', oneTimeCustomers.map(l => l.id));

      segmentChanges.one_time_detection = oneTimeCustomers.length;
      console.log(`[${executionId}] Detected ${oneTimeCustomers.length} one-time customers`);
    }

    // ============================================================================
    // 4. REENGAGEMENT SEQUENCE (one-time customers, ready for follow-up)
    // ============================================================================
    const { data: readyReengagement, error: e4 } = await db
      .from('leads')
      .select('id')
      .eq('segment', 'one_time')
      .lt('last_booking_date', threeDaysAgo.toISOString());

    if (!e4 && readyReengagement?.length > 0) {
      await db
        .from('leads')
        .update({
          segment: 'reengagement',
          segment_moved_at: now.toISOString()
        })
        .in('id', readyReengagement.map(l => l.id));

      console.log(`[${executionId}] Moved ${readyReengagement.length} leads to reengagement`);
    }

    // ============================================================================
    // 5. CANCELED CLIENT DETECTION & WIN-BACK
    // ============================================================================
    // Find leads that were converted (customers) but now have no recent bookings and status = "canceled"
    // (You'd need a way to track when customer was canceled - for now we check if they were converted but have 0 bookings)

    // This would require additional tracking on the clients table
    // For now, we'll assume you manually mark leads as canceled

    console.log(`[${executionId}] Segment detection complete:`, segmentChanges);

    return res.status(200).json({
      success: true,
      changes: segmentChanges,
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
