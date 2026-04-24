/**
 * POST /api/feedback
 * Body: { appointmentId, clientId, rating: 'positive'|'negative', message? }
 * Saves feedback to Supabase, returns client name + booking URL
 */
import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { appointmentId, clientId, rating, message } = req.body || {};
    if (!clientId || !rating) return res.status(400).json({ error: 'clientId and rating required' });

    // Save to client_feedback table
    await db.from('client_feedback').insert([{
      appointment_id: appointmentId || null,
      client_id: clientId,
      rating,
      message: message || null,
    }]);

    // Get client name for the response
    const { data: client } = await db.from('clients')
      .select('name')
      .eq('id', clientId)
      .maybeSingle();

    // If negative feedback, create a VA task to follow up
    if (rating === 'negative' && message) {
      const name = client?.name || 'Client';
      await db.from('tasks').insert([{
        title: `Follow up — ${name} left feedback`,
        type: 'call_client',
        priority: 'high',
        description: `Feedback received: "${message.slice(0, 200)}"`,
        related_client_id: clientId,
        status: 'open',
        due_date: new Date().toISOString().split('T')[0],
      }]);
    }

    const firstName = (client?.name || 'there').split(' ')[0];
    return res.status(200).json({
      success: true,
      firstName,
      bookingUrl: 'https://hnc-crm.vercel.app/contact',
    });
  } catch (err) {
    await logError('feedback', err, {});
    return res.status(500).json({ error: err.message });
  }
}
