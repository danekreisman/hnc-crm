module.exports = async (req, res) => {
  try {
    var cleanerId = (req.query && req.query.cleaner_id) || '';
    if (!cleanerId) { res.statusCode = 400; res.setHeader('content-type','text/plain'); return res.end('Missing cleaner_id'); }
    var clientId = process.env.GOOGLE_CLIENT_ID;
    var redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) { res.statusCode = 500; res.setHeader('content-type','text/plain'); return res.end('Server is missing GOOGLE_CLIENT_ID / GOOGLE_REDIRECT_URI'); }
    var scope = 'https://www.googleapis.com/auth/calendar.events';
    var params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent', scope: scope, state: cleanerId });
    var authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
    res.statusCode = 302; res.setHeader('Location', authUrl); res.end();
  } catch (err) {
    res.statusCode = 500; res.setHeader('content-type','text/plain'); res.end('authorize error: ' + (err && err.message ? err.message : String(err)));
  }
};
