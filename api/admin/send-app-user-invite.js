// api/admin/send-app-user-invite.js
//
// Admin-gated endpoint that sends a branded welcome email to a newly-
// invited CRM team member (admin/va/assistant role in the app_users
// allowlist). The DB allowlist insert itself happens client-side in
// inviteAppUser(); this endpoint only sends the email so the recipient
// knows they've been added and where to sign in.
//
// Soft-fail by design: if Resend errors, the user is still on the
// allowlist and can sign in — the caller is told email_sent:false and
// surfaces a "added, but couldn't email" message.

import { fetchWithTimeout, TIMEOUTS } from '../utils/with-timeout.js';
import { logError } from '../utils/error-logger.js';
import { requireAdmin } from '../utils/auth-check.js';
import { validate, is } from '../utils/validate.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Hawaii Natural Clean <dane@hawaiinaturalclean.com>';
const SIGN_IN_URL = 'https://book.hawaiinaturalclean.com';

const ROLE_LABEL = {
  admin:     'Admin',
  va:        'VA',
  assistant: 'Assistant',
};

const ROLE_DESCRIPTION = {
  admin:     'You have full access to the CRM — including payments, settings, and managing other users.',
  va:        'You can manage leads, send follow-ups, and complete VA tasks.',
  assistant: 'You can view and assist with day-to-day CRM operations.',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Admin-only — only existing admins can invite new team members.
  const user = await requireAdmin(req, res);
  if (!user) return;

  // ─── Validate input ─────────────────────────────────────────────────────
  const SCHEMA = {
    email: { required: true, rules: [is.email, is.maxLength(200)], message: 'A valid email is required' },
    role:  { required: true, rules: [is.oneOf(['admin','va','assistant'])], message: 'Role must be admin, va, or assistant' },
  };
  const result = validate(req.body || {}, SCHEMA);
  if (!result.valid) {
    return res.status(400).json({ ok: false, error: 'validation_failed', details: result.errors });
  }

  const email     = req.body.email.trim().toLowerCase();
  const role      = req.body.role;
  const inviterEmail = (user.email || '').toLowerCase();
  const inviterName  = inviterEmail.split('@')[0] || 'the team';
  const roleLabel = ROLE_LABEL[role];
  const roleDesc  = ROLE_DESCRIPTION[role];

  // ─── Render branded email ───────────────────────────────────────────────
  // Inlined here rather than going through /api/send-email so the auth
  // gate stays clean and we don't have to add a new `type` branch over
  // there. Style mirrors the renderBrandedEmail() shell so the look is
  // consistent with all other HNC-branded mail.
  const subject = `You've been added to the Hawaii Natural Clean CRM`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Hawaii Natural Clean</title>
</head>
<body style="margin:0;padding:0;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#FFFFFF;opacity:0;">You've been added to the Hawaii Natural Clean CRM as ${roleLabel}.</div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#FFFFFF;">
    <tr>
      <td align="center" style="padding:0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;padding:40px 32px;">
          <tr>
            <td align="center" style="padding:8px 0 20px;">
              <img src="https://hnc-crm.vercel.app/hnc-logo.png" alt="Hawaii Natural Clean" width="180" style="display:block;height:auto;max-width:180px;border:0;">
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 0 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
                <td style="height:3px;width:48px;background:#3BB8E3;border-radius:2px;line-height:3px;font-size:1px;">&nbsp;</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:0;">
              <h1 style="margin:0 0 12px;color:#0F172A;font-size:24px;font-weight:700;line-height:1.25;letter-spacing:-0.01em;font-family:Georgia,'Times New Roman',serif;">You've been added to the HNC CRM</h1>
              <p style="margin:0 0 20px;color:#64748B;font-size:15px;line-height:1.6;">
                Aloha — <strong style="color:#0F172A;">${inviterName}</strong> just added you as <strong style="color:#0F172A;">${roleLabel}</strong> in the Hawaii Natural Clean CRM.
              </p>
              <div style="background:#EFF9FC;border-radius:10px;padding:16px 18px;margin:0 0 24px;">
                <p style="margin:0;color:#0F172A;font-size:14px;line-height:1.6;">${roleDesc}</p>
              </div>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0;">
                <tr><td align="center">
                  <a href="${SIGN_IN_URL}" style="display:inline-block;background:#3BB8E3;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:999px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:.01em;">Sign in to the CRM</a>
                </td></tr>
              </table>
              <p style="margin:28px 0 0;padding:16px;background:#EFF9FC;border-radius:10px;color:#64748B;font-size:13px;line-height:1.55;">
                Sign in with your Google account at <a href="${SIGN_IN_URL}" style="color:#3BB8E3;text-decoration:none;">book.hawaiinaturalclean.com</a> using <strong style="color:#0F172A;">${email}</strong>. If that's not your Google address, reply to this email and we'll update it.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:48px 0 0;text-align:center;border-top:1px solid #E2E8F0;">
              <div style="padding-top:24px;">
                <p style="margin:0 0 6px;color:#0F172A;font-size:14px;font-weight:600;font-family:Georgia,serif;letter-spacing:.02em;">Hawaii Natural Clean</p>
                <p style="margin:0 0 4px;color:#64748B;font-size:12px;">Oahu & Maui, Hawaii</p>
                <p style="margin:0;color:#64748B;font-size:12px;">
                  <a href="tel:8084685356" style="color:#3BB8E3;text-decoration:none;">(808) 468-5356</a>
                  &nbsp;·&nbsp;
                  <a href="https://hawaiinaturalclean.com" style="color:#3BB8E3;text-decoration:none;">hawaiinaturalclean.com</a>
                </p>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // ─── Send via Resend ────────────────────────────────────────────────────
  try {
    const r = await fetchWithTimeout(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: FROM_EMAIL, to: [email], subject, html })
      },
      TIMEOUTS.RESEND
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      await logError('admin/send-app-user-invite', `Resend failed: ${r.status}`, { email, role, response: data });
      return res.status(502).json({ ok: false, email_sent: false, status: r.status, error: 'resend_failed' });
    }
    return res.status(200).json({ ok: true, email_sent: true, resend_id: data.id });
  } catch (err) {
    await logError('admin/send-app-user-invite', err, { email, role });
    return res.status(500).json({ ok: false, email_sent: false, error: err && err.message ? err.message : String(err) });
  }
}
