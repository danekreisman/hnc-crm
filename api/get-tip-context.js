// HNC CRM — /api/get-tip-context (phase 2 of tipping feature, 2026-05-03)
//
// Public endpoint, token-gated. Returns the minimum appointment context needed
// to render tip.html: client first name, cleaner first name, service date,
// service type, and any tip already paid. NO addresses, phones, prices, or
// admin-side data — assume the client may forward the link.
//
// Auth: HMAC token passed as ?token=... Verified server-side via tip-token.js.
// Token expiry is 30 days by default (set when admin generated the link).
//
// This endpoint deliberately does not respect the Stripe kill switch — it only
// reads info, doesn't move money. Even if charging is disabled, customers can
// still see a "Tip your cleaner" page (the create-checkout endpoint is what
// actually fails behind the kill switch).

import { verifyTipToken } from './utils/tip-token.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function _firstName(s) {
  return String(s || '').trim().split(/\s+/)[0] || '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Token from query (GET) or body (POST)
  const token = (req.query && req.query.token) || (req.body && req.body.token) || '';

  let v;
  try {
    v = verifyTipToken(token);
  } catch (e) {
    await logError('get-tip-context', e, { token_len: (token || '').length });
    return res.status(500).json({ error: 'token_verify_failed', message: 'Server misconfiguration' });
  }
  if (!v.valid) {
    return res.status(401).json({ error: 'invalid_token', reason: v.reason });
  }

  try {
    // Fetch appointment via REST (matches the pattern used by stripe-invoice.js
    // duplicate guard — sidesteps the @supabase/supabase-js import in the
    // serverless environment).
    const apptUrl = SUPABASE_URL +
      '/rest/v1/appointments?select=id,date,time,service,status,tip_amount,client_id,cleaner_id,cleaner_id_2,cleaner_id_3' +
      '&id=eq.' + encodeURIComponent(v.appointmentId);
    const apptRes = await fetchWithTimeout(apptUrl, {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
    }, TIMEOUTS.SUPABASE);
    if (!apptRes.ok) {
      const txt = await apptRes.text().catch(() => '');
      await logError('get-tip-context', new Error('appt fetch failed'), { status: apptRes.status, body: txt.slice(0, 200) });
      return res.status(502).json({ error: 'lookup_failed' });
    }
    const appts = await apptRes.json();
    if (!appts || !appts.length) {
      return res.status(404).json({ error: 'appointment_not_found' });
    }
    const appt = appts[0];
    if (appt.status === 'deleted' || appt.status === 'cancelled') {
      return res.status(404).json({ error: 'appointment_unavailable' });
    }

    // Resolve client first name + cleaner first name(s)
    const clientP = appt.client_id ? fetchWithTimeout(
      SUPABASE_URL + '/rest/v1/clients?select=id,name&id=eq.' + appt.client_id,
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } },
      TIMEOUTS.SUPABASE
    ) : Promise.resolve(null);

    const cleanerIds = [appt.cleaner_id, appt.cleaner_id_2, appt.cleaner_id_3].filter(Boolean);
    const cleanersP = cleanerIds.length ? fetchWithTimeout(
      SUPABASE_URL + '/rest/v1/cleaners?select=id,name&id=in.(' + cleanerIds.map(encodeURIComponent).join(',') + ')',
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } },
      TIMEOUTS.SUPABASE
    ) : Promise.resolve(null);

    const [clientRes, cleanersRes] = await Promise.all([clientP, cleanersP]);

    let clientFirstName = 'there';
    if (clientRes && clientRes.ok) {
      const clients = await clientRes.json();
      if (clients && clients[0]) clientFirstName = _firstName(clients[0].name) || 'there';
    }

    let cleanerNames = [];
    if (cleanersRes && cleanersRes.ok) {
      const cleaners = await cleanersRes.json();
      // Preserve order: primary first, then 2, then 3
      const byId = {};
      (cleaners || []).forEach(c => { byId[c.id] = _firstName(c.name); });
      cleanerNames = cleanerIds.map(id => byId[id]).filter(Boolean);
    }

    // Format date as a friendly string ("Sat, Apr 26") — the client doesn't
    // need machine-readable dates here.
    let prettyDate = appt.date;
    try {
      const d = new Date(appt.date + 'T12:00:00');
      prettyDate = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch (_) {}

    return res.status(200).json({
      success: true,
      clientFirstName,
      cleanerNames,
      cleanerCount: cleanerNames.length || 1,
      service: appt.service || 'cleaning',
      date: prettyDate,
      isCompleted: appt.status === 'completed' || appt.status === 'paid',
      alreadyTipped: !!(appt.tip_amount && +appt.tip_amount > 0),
      currentTipAmount: +appt.tip_amount || 0,
      // Echo back the appointment id so tip.html can use it on the next call,
      // saving a re-decode round trip. Token is still required by the next
      // endpoint — this is convenience, not auth.
      appointmentId: appt.id
    });
  } catch (err) {
    await logError('get-tip-context', err, { appointmentId: v.appointmentId });
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}
