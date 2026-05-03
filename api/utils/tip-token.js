// HNC CRM — tip token helpers (phase 2 of tipping feature, 2026-05-03)
//
// Tokens are used in the public client-facing tip flow because the client is
// not an admin and therefore cannot pass requireAdmin. The token format is:
//
//     <appointment_uuid>.<expires_unix_seconds>.<hex_sig>
//
// where hex_sig is the first 32 hex chars (16 bytes) of HMAC-SHA256 over the
// string "<appointment_uuid>|<expires_unix_seconds>" using TIP_TOKEN_SECRET.
//
// Design notes:
// - No default secret. If TIP_TOKEN_SECRET is missing the helpers refuse to
//   produce or verify tokens. This forces an explicit env-var setup in Vercel
//   rather than silently falling back to a guessable signing key.
// - Constant-time comparison to defend against signature-timing attacks.
// - Short signature (16 bytes) keeps the token SMS-friendly while remaining
//   computationally infeasible to forge (~10^38 possibilities). 36 char UUID
//   + 1 + 10 + 1 + 32 = 80 chars total.
// - The signature DOES NOT cover the amount. Amount is supplied at the
//   /api/create-tip-checkout call site; the token only authorizes "this
//   appointment can receive a tip until <expires_at>". Amount-binding would
//   force a new token for every preset, which breaks UX.

import crypto from 'crypto';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function _secret() {
  const s = process.env.TIP_TOKEN_SECRET;
  if (!s || String(s).length < 16) {
    const err = new Error('TIP_TOKEN_SECRET is not set or too short (min 16 chars)');
    err.code = 'tip_token_secret_missing';
    throw err;
  }
  return s;
}

function _sign(payload) {
  const h = crypto.createHmac('sha256', _secret());
  h.update(payload);
  return h.digest('hex').slice(0, 32);
}

export function generateTipToken(appointmentId, ttlSeconds) {
  if (!appointmentId || typeof appointmentId !== 'string') {
    throw new Error('generateTipToken: appointmentId required');
  }
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = appointmentId + '|' + exp;
  const sig = _sign(payload);
  return appointmentId + '.' + exp + '.' + sig;
}

export function verifyTipToken(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'missing_token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  const [appointmentId, expStr, sig] = parts;
  if (!appointmentId || !expStr || !sig) {
    return { valid: false, reason: 'malformed' };
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) {
    return { valid: false, reason: 'malformed' };
  }
  if (exp < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'expired' };
  }
  let expected;
  try {
    expected = _sign(appointmentId + '|' + expStr);
  } catch (e) {
    return { valid: false, reason: 'config_error', detail: e.message };
  }
  // Constant-time compare to mitigate timing attacks
  let mismatch = sig.length !== expected.length ? 1 : 0;
  for (let i = 0; i < sig.length && i < expected.length; i++) {
    mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return { valid: false, reason: 'bad_signature' };
  }
  return { valid: true, appointmentId, expiresAt: exp };
}
