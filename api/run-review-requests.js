/**
 * POST /api/run-review-requests  (Vercel cron: daily at 7am UTC = 9pm HST)
 *
 * For each appointment completed in the last 24 hours:
 * 1. Pull client's recent OpenPhone SMS history (last 20 messages)
 * 2. Ask Claude: "Does this customer seem satisfied? Yes/No + confidence"
 * 3. If satisfied (confidence >= 0.7) → send Google review request SMS
 * 4. If not satisfied → skip silently, log reason
 *
 * Never sends more than one review request per client (tracked via
 * review_requested_at on the appointments table).
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const BASE_URL       = 'https://hnc-crm.vercel.app';
const BUSINESS_NAME  = 'Hawaii Natural Clean';
const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // ── Safety guard ─────────────────────────────────────────────────────────
  // When called manually (not by cron), require an explicit testClientId to
  // prevent accidentally processing real clients during development/testing.
  // The Vercel cron caller sets x-vercel-cron header automatically.
  const isCron = req.headers['x-vercel-cron'] === '1';
  const { testClientId } = req.body || {};
  if (!isCron && !testClientId) {
    return res.status(400).json({
      error: 'Manual calls require testClientId in body. To test, pass a specific client ID. Cron calls run automatically.'
    });
  }

  try {
    // Get review URL from settings
    const { data: reviewSetting } = await db
      .from('settings').select('value').eq('key', 'google_review_url').maybeSingle();
    const reviewUrl = reviewSetting?.value || 'https://g.page/r/CfqMUR341NgqEBM/review';

    // Find appointments completed in the last 7 days, not yet reviewed
    // (using date field since updated_at can't be relied on for existing rows)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    let query = db
      .from('appointments')
      .select(`
        id, date, time, service,
        clients ( id, name, phone )
      `)
      .eq('status', 'completed')
      .gte('date', sevenDaysAgo)
      .lte('date', today)
      .is('review_requested_at', null);

    // In test mode, restrict to the specified client only
    if (testClientId) {
      query = query.eq('client_id', testClientId);
    }

    const { data: appointments, error } = await query;

    if (error) throw error;
    if (!appointments?.length) {
      return res.status(200).json({ success: true, reviewed: 0, skipped: 0, message: 'No completed jobs in last 24h' });
    }

    let reviewed = 0, skipped = 0;
    const results = [];

    for (const appt of appointments) {
      const client = appt.clients;
      if (!client?.phone) { skipped++; continue; }

      const clientId = client.id;
      const firstName = (client.name || 'there').split(' ')[0];
      const phone = client.phone.replace(/\D/g, '');
      const e164  = client.phone.startsWith('+') ? client.phone : `+1${phone}`;

      // ── 1. Pull recent SMS history from Supabase (OpenPhone webhooks) ──
      const { data: messages } = await db
        .from('messages')
        .select('body, direction, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(20);

      const history = (messages || [])
        .reverse()
        .map(m => `[${m.direction === 'inbound' ? 'Client' : 'HNC'}]: ${m.body}`)
        .join('\n');

      // ── 2. Ask AI: is this customer satisfied? ─────────────────────────
      let satisfied = false;
      let confidence = 0;
      let aiReason = 'no history';

      if (history.length > 0) {
        try {
          const aiResp = await fetchWithTimeout(ANTHROPIC_API, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-5',
              max_tokens: 150,
              system: `You analyze customer SMS conversations for a cleaning business and determine whether the customer seems satisfied.
Respond ONLY with valid JSON: {"satisfied": true/false, "confidence": 0.0-1.0, "reason": "one sentence"}
A confidence of 0.7+ means you are fairly sure. If there is no clear signal, default to false.
Never send a review request to a dissatisfied or upset customer.`,
              messages: [{
                role: 'user',
                content: `Customer: ${client.name}\nRecent SMS history:\n${history}\n\nIs this customer satisfied with their cleaning service?`,
              }],
            }),
          }, TIMEOUTS.ANTHROPIC);

          const aiData = await aiResp.json();
          const raw = aiData.content?.[0]?.text || '{}';
          const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
          satisfied  = parsed.satisfied === true;
          confidence = parsed.confidence || 0;
          aiReason   = parsed.reason || '';
        } catch (aiErr) {
          await logError('run-review-requests:ai', aiErr, { clientId, apptId: appt.id });
          skipped++;
          continue;
        }
      }

      // ── 3. Send review request if satisfied ───────────────────────────
      if (satisfied && confidence >= 0.7) {
        const message = `Aloha ${firstName}! 🌺 Thank you so much for choosing ${BUSINESS_NAME}. We hope your home is feeling fresh and clean! If you have a moment, we'd love it if you left us a Google review — it means the world to our small team: ${reviewUrl} Mahalo! 🌺`;

        try {
          const smsResp = await fetchWithTimeout(`${BASE_URL}/api/send-sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: e164, message }),
          }, TIMEOUTS.OPENPHONE);

          if (smsResp.ok) {
            // Mark appointment so we never send again
            await db.from('appointments')
              .update({ review_requested_at: new Date().toISOString() })
              .eq('id', appt.id);
            reviewed++;
            console.log(`[run-review-requests] Sent review request to ${client.name} (confidence: ${confidence})`);
          }
        } catch (smsErr) {
          await logError('run-review-requests:sms', smsErr, { clientId, apptId: appt.id });
        }
      } else {
        skipped++;
        console.log(`[run-review-requests] Skipped ${client.name} — satisfied:${satisfied} confidence:${confidence} reason:${aiReason}`);
        // Still mark it so we don't re-evaluate tomorrow
        await db.from('appointments')
          .update({ review_requested_at: new Date().toISOString() + '_skipped' })
          .eq('id', appt.id);
      }

      results.push({ client: client.name, satisfied, confidence, sent: satisfied && confidence >= 0.7 });
    }

    return res.status(200).json({ success: true, reviewed, skipped, results });

  } catch (err) {
    await logError('run-review-requests', err, {});
    return res.status(500).json({ error: err.message });
  }
}
