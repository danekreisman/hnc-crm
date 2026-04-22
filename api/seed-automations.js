import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // The 4 pre-built automations
  const automations = [
    {
      name: 'Initial 3-day follow-up',
      description: 'Send follow-up SMS on day 3 for leads in initial_sequence',
      trigger_type: 'days_since_response',
      trigger_config: { days: 3 },
      actions: [
        {
          type: 'sms',
          message: 'Hi {firstName}, still interested in {service}? We\'d love to help! Let us know if you have any questions.',
          delay_minutes: 0
        }
      ],
      is_enabled: true,
      created_by: 'System'
    },
    {
      name: 'Nurture 30-day check-in',
      description: 'Monthly check-in for leads in nurture segment',
      trigger_type: 'scheduled',
      trigger_config: { time_of_day: '09:00', days: ['MO'] },
      actions: [
        {
          type: 'sms',
          message: 'Still thinking about {service}? We\'re here to help whenever you\'re ready!',
          delay_minutes: 0
        }
      ],
      is_enabled: true,
      created_by: 'System'
    },
    {
      name: 'Post-booking re-engagement',
      description: 'Send follow-up 3 days after booking to encourage rebook',
      trigger_type: 'booking_completed',
      trigger_config: { hours_after: 72 },
      actions: [
        {
          type: 'sms',
          message: 'Thanks for choosing Hawaii Natural Clean! Ready for your next {service}? Let us know!',
          delay_minutes: 0
        },
        {
          type: 'segment_move',
          new_segment: 'one_time',
          delay_minutes: 0
        }
      ],
      is_enabled: true,
      created_by: 'System'
    },
    {
      name: 'Canceled customer win-back',
      description: 'Slow win-back sequence for canceled customers (monthly)',
      trigger_type: 'scheduled',
      trigger_config: { time_of_day: '10:00', days: ['MO'] },
      actions: [
        {
          type: 'sms',
          message: 'We miss you! Your home could use a refresh. Let\'s get you scheduled again!',
          delay_minutes: 0
        }
      ],
      is_enabled: false,
      created_by: 'System'
    }
  ];

  try {
    // Delete any existing system automations first
    await db
      .from('lead_automations')
      .delete()
      .eq('created_by', 'System');

    // Insert the new automations
    const { data, error } = await db
      .from('lead_automations')
      .insert(automations)
      .select();

    if (error) throw error;

    console.log(`[seed-automations] Created ${data.length} automations`);

    return res.status(200).json({
      success: true,
      created: data.length,
      automations: data
    });
  } catch (error) {
    console.error('[seed-automations]', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
