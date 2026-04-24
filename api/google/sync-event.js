import { fetchWithTimeout } from '../utils/with-timeout.js';
import { logError } from '../utils/error-logger.js';
const { createClient } = require('@supabase/supabase-js');
var GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
var CAL_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
function jsonRes(res, code, body) { res.statusCode = code; res.setHeader('content-type','application/json'); res.end(JSON.stringify(body)); }
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    var data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
async function refreshAccessToken(integration) {
  var body = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: integration.refresh_token, grant_type: 'refresh_token' });
  var r = await fetchWithTimeout(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'content-type':'application/x-www-form-urlencoded' }, 10000), body: body.toString() });
  var j = await r.json();
  if (!r.ok) throw new Error('Refresh failed: ' + JSON.stringify(j));
  return { access_token: j.access_token, expires_at: new Date(Date.now() + Math.max(0, (j.expires_in || 0) - 60) * 1000).toISOString() };
}
async function getValidAccessToken(supabase, integration) {
  var now = Date.now();
  var exp = integration.expires_at ? new Date(integration.expires_at).getTime() : 0;
  if (integration.access_token && exp > now + 30000) return integration.access_token;
  if (!integration.refresh_token) throw new Error('Access token expired and no refresh_token on file. Cleaner must re-authorize.');
  var refreshed = await refreshAccessToken(integration);
  await supabase.from('cleaner_integrations').update({ access_token: refreshed.access_token, expires_at: refreshed.expires_at, updated_at: new Date().toISOString() }).eq('id', integration.id);
  return refreshed.access_token;
}
function buildEventPayload(appt, cleaner) {
  var tz = 'Pacific/Honolulu';
  var summary = 'HNC: ' + (appt.client_name || 'Cleaning');
  var descLines = [];
  if (appt.service) descLines.push('Service: ' + appt.service);
  if (appt.frequency) descLines.push('Frequency: ' + appt.frequency);
  if (appt.beds != null || appt.baths != null) descLines.push('Beds/Baths: ' + (appt.beds != null ? appt.beds : '?') + ' / ' + (appt.baths != null ? appt.baths : '?'));
  if (appt.sqft) descLines.push('Sqft: ' + appt.sqft);
  if (appt.notes) descLines.push('Notes: ' + appt.notes);
  var _durH = Number(appt.duration_hours || 0); if (_durH > 0) descLines.push('Estimated hours: ' + _durH); var _rate = Number(cleaner && cleaner.hourly_rate || 0); if (_durH > 0 && _rate > 0) descLines.push('Your pay: $' + (_durH * _rate).toFixed(2));
  var base = { summary: summary, description: descLines.join('\n'), location: appt.address || '' };
  if (appt.time && /^\d{1,2}:\d{2}/.test(appt.time)) {
    var parts = appt.time.split(':').map(function(x){ return parseInt(x, 10); });
    var h = parts[0], m = parts[1];
    var durHours = Number(appt.duration_hours) > 0 ? Number(appt.duration_hours) : 2;
    var start = new Date(appt.date + 'T' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':00');
    var end = new Date(start.getTime() + durHours * 3600000);
    var pad = function(n){ return String(n).padStart(2,'0'); };
    var fmt = function(d){ return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00'; };
    base.start = { dateTime: fmt(start), timeZone: tz };
    base.end = { dateTime: fmt(end), timeZone: tz };
  } else {
    var startD = appt.date;
    var endDate = new Date(appt.date + 'T00:00:00');
    endDate.setDate(endDate.getDate() + 1);
    var pad2 = function(n){ return String(n).padStart(2,'0'); };
    var endStr = endDate.getFullYear() + '-' + pad2(endDate.getMonth()+1) + '-' + pad2(endDate.getDate());
    base.start = { date: startD };
    base.end = { date: endStr };
  }
  return base;
}
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return jsonRes(res, 405, { ok: false, error: 'Method not allowed' });
    var supabaseUrl = process.env.SUPABASE_URL;
    var supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) return jsonRes(res, 500, { ok: false, error: 'Server missing SUPABASE env vars' });
    var body = await readBody(req);
    var action = body.action || 'upsert';
    var appointmentId = body.appointment_id;
    if (!appointmentId) return jsonRes(res, 400, { ok: false, error: 'Missing appointment_id' });
    var supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    var apptResp = await supabase.from('appointments').select('*').eq('id', appointmentId).maybeSingle();
    if (apptResp.error) return jsonRes(res, 500, { ok: false, error: apptResp.error.message });
    var appt = apptResp.data;
    if (!appt) return jsonRes(res, 404, { ok: false, error: 'Appointment not found' });
    var cleanerId = appt.cleaner_id || null;
    if (!cleanerId && appt.cleaner_name) {
      var cResp = await supabase.from('cleaners').select('id').eq('name', appt.cleaner_name).maybeSingle();
      if (cResp.data) cleanerId = cResp.data.id;
    }
    var existingEventId = appt.google_event_id || null;
  var ownerCleanerId = appt.google_event_cleaner_id || null;
  var isCancelled = (appt.status === 'cancelled');
  var isUnassigned = (appt.status === 'unassigned') || (appt.cleaner_name && String(appt.cleaner_name).toLowerCase() === 'unassigned');
  if (isUnassigned) { cleanerId = null; }
  if (!cleanerId && !existingEventId && !isCancelled) return jsonRes(res, 200, { ok: true, skipped: 'no cleaner assigned and no existing event' });
  async function _deleteFromOwner(reason) {
    var ownerId = ownerCleanerId || cleanerId;
    if (existingEventId && ownerId) {
      var ownerIntegResp = await supabase.from('cleaner_integrations').select('*').eq('cleaner_id', ownerId).eq('provider', 'google').maybeSingle();
      var ownerInteg = ownerIntegResp.data || null;
      if (ownerInteg) {
        try {
          var tokOwner = await getValidAccessToken(supabase, ownerInteg);
          await fetchWithTimeout(CAL_EVENTS_URL + '/' + encodeURIComponent(existingEventId), { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokOwner }, 10000) });
        } catch (e) {}
      }
    }
    await supabase.from('appointments').update({ google_event_id: null, google_event_cleaner_id: null }).eq('id', appointmentId);
    return jsonRes(res, 200, { ok: true, deleted: true, reason: reason });
  }
  if (action === 'delete' || isCancelled || isUnassigned || !cleanerId) {
    return await _deleteFromOwner(action === 'delete' ? 'delete' : (isCancelled ? 'cancelled' : 'unassigned'));
  }
  if (ownerCleanerId && ownerCleanerId !== cleanerId && existingEventId) {
    var oldOwnerIntegResp = await supabase.from('cleaner_integrations').select('*').eq('cleaner_id', ownerCleanerId).eq('provider', 'google').maybeSingle();
    var oldOwnerInteg = oldOwnerIntegResp.data || null;
    if (oldOwnerInteg) {
      try {
        var tokOld = await getValidAccessToken(supabase, oldOwnerInteg);
        await fetchWithTimeout(CAL_EVENTS_URL + '/' + encodeURIComponent(existingEventId), { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokOld }, 10000) });
      } catch (e) {}
    }
    existingEventId = null;
    await supabase.from('appointments').update({ google_event_id: null, google_event_cleaner_id: null }).eq('id', appointmentId);
  }
  var integration = null;
  var iResp = await supabase.from('cleaner_integrations').select('*').eq('cleaner_id', cleanerId).eq('provider', 'google').maybeSingle();
  integration = iResp.data || null;
  if (!integration) {
    if (existingEventId) await supabase.from('appointments').update({ google_event_id: null, google_event_cleaner_id: null }).eq('id', appointmentId);
    return jsonRes(res, 200, { ok: true, skipped: 'cleaner has no Google integration' });
  }
  var token = await getValidAccessToken(supabase, integration);
    var cleanerRecord = null; if (cleanerId) { var _cr = await supabase.from('cleaners').select('id,name,hourly_rate').eq('id', cleanerId).maybeSingle(); cleanerRecord = _cr.data || null; } var payload = buildEventPayload(appt, cleanerRecord);
    var method = 'POST';
    var url = CAL_EVENTS_URL;
    if (existingEventId) { method = 'PATCH'; url = CAL_EVENTS_URL + '/' + encodeURIComponent(existingEventId); }
    var r = await fetchWithTimeout(url, { method: method, headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, 10000), body: JSON.stringify(payload) });
    var j = await r.json();
    if (!r.ok && existingEventId && r.status === 404) {
      var r2 = await fetchWithTimeout(CAL_EVENTS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, 10000), body: JSON.stringify(payload) });
      var j2 = await r2.json();
      if (!r2.ok) return jsonRes(res, 502, { ok: false, error: 'Google error', detail: j2 });
      await supabase.from('appointments').update({ google_event_id: j2.id, google_event_cleaner_id: cleanerId }).eq('id', appointmentId);
      return jsonRes(res, 200, { ok: true, event_id: j2.id, recreated: true });
    }
    if (!r.ok) return jsonRes(res, 502, { ok: false, error: 'Google error', detail: j });
    await supabase.from('appointments').update({ google_event_id: j.id, google_event_cleaner_id: cleanerId }).eq('id', appointmentId);
    return jsonRes(res, 200, { ok: true, event_id: j.id });
  } catch (err) {
    return jsonRes(res, 500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
