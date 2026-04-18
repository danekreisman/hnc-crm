const { createClient } = require('@supabase/supabase-js');
module.exports = async (req, res) => {
  try {
    var code = req.query && req.query.code;
    var cleanerId = req.query && req.query.state;
    var oauthError = req.query && req.query.error;
    if (oauthError) { res.statusCode = 400; res.setHeader('content-type','text/html'); return res.end('<h1>Google authorization failed</h1><p>' + String(oauthError) + '</p>'); }
    if (!code || !cleanerId) { res.statusCode = 400; res.setHeader('content-type','text/plain'); return res.end('Missing code or state'); }
    var clientId = process.env.GOOGLE_CLIENT_ID;
    var clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    var redirectUri = process.env.GOOGLE_REDIRECT_URI;
    var supabaseUrl = process.env.SUPABASE_URL;
    var supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!clientId || !clientSecret || !redirectUri || !supabaseUrl || !supabaseKey) { res.statusCode = 500; res.setHeader('content-type','text/plain'); return res.end('Server missing required environment variables'); }
    var tokenBody = new URLSearchParams({ code: code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    var tokenResp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenBody.toString() });
    var tokenJson = await tokenResp.json();
    if (!tokenResp.ok) { res.statusCode = 400; res.setHeader('content-type','text/plain'); return res.end('Token exchange failed: ' + JSON.stringify(tokenJson)); }
    var accessToken = tokenJson.access_token;
    var refreshToken = tokenJson.refresh_token || null;
    var expiresIn = Number(tokenJson.expires_in || 0);
    var scope = tokenJson.scope || '';
    var expiresAt = new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000).toISOString();
    var googleEmail = null;
    try {
      var uiResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } });
      if (uiResp.ok) { var ui = await uiResp.json(); googleEmail = ui.email || null; }
    } catch (_) {}
    var supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    var row = { cleaner_id: cleanerId, provider: 'google', google_email: googleEmail, access_token: accessToken, refresh_token: refreshToken, scope: scope, expires_at: expiresAt, updated_at: new Date().toISOString() };
    var upsertErr = null;
    {
      var r1 = await supabase.from('cleaner_integrations').upsert(row, { onConflict: 'cleaner_id,provider' });
      upsertErr = r1.error;
    }
    if (upsertErr) {
      var r2 = await supabase.from('cleaner_integrations').select('id').eq('cleaner_id', cleanerId).eq('provider', 'google').maybeSingle();
      var existing = r2.data;
      if (existing && existing.id) {
        var r3 = await supabase.from('cleaner_integrations').update(row).eq('id', existing.id);
        if (r3.error) throw r3.error;
      } else {
        var r4 = await supabase.from('cleaner_integrations').insert(row);
        if (r4.error) throw r4.error;
      }
    }
    if (googleEmail) { await supabase.from('cleaners').update({ email: googleEmail }).eq('id', cleanerId); }
    res.statusCode = 200; res.setHeader('content-type','text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>Google Calendar linked</title><body style="font-family:system-ui;padding:32px;max-width:560px;margin:auto;"><h1>Google Calendar linked &#10003;</h1><p>You can close this window. Appointments assigned to you will now sync to ' + (googleEmail ? ('<b>' + googleEmail + '</b>') : 'your Google Calendar') + '.</p><script>setTimeout(function(){window.close();},1500);</script></body>');
  } catch (err) {
    res.statusCode = 500; res.setHeader('content-type','text/plain'); res.end('callback error: ' + (err && err.message ? err.message : String(err)));
  }
};
