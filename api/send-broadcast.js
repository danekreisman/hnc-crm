/**
 * POST /api/send-broadcast
 *
 * Sends a holiday broadcast email to all opted-in leads, clients, or both.
 * Idempotent — skips recipients already in broadcast_sends for this broadcast.
 * Can be triggered manually from the UI or by the Vercel cron job.
 *
 * Body:
 *   broadcastId: string (required) — UUID of the broadcast to send
 *
 * Returns:
 *   { success, sent, skipped, failed, broadcastId }
 */

import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

const BASE_URL  = 'https://hnc-crm.vercel.app';
const BUSINESS  = 'Hawaii Natural Clean';
const PHONE     = '(808) 468-5356';
const WEBSITE   = 'hawaiinaturalclean.com';

// ─── Holiday template library ─────────────────────────────────────────────────
// Each template receives { firstName, unsubscribeUrl } at render time.
const HOLIDAY_TEMPLATES = {
  easter: {
    defaultSubject: '🌸 Spring is here — time for a fresh start',
    preheader: 'Give your home the spring refresh it deserves.',
    heading: 'Aloha — spring has arrived! 🌸',
    intro: (firstName) => `Aloha ${firstName}! With Easter and spring here, there's no better time to give your home a deep, thorough clean.`,
    body: `
      <p style="margin:0 0 16px;color:#0F172A;font-size:15px;line-height:1.65;">After the winter months, dust, allergens, and grime settle into every corner. Our spring deep clean gets everything — baseboards, windows, kitchens, bathrooms — leaving your home feeling genuinely renewed.</p>
      <div style="background:#EFF9FC;border-radius:12px;padding:20px 24px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 6px;color:#0F172A;font-size:18px;font-weight:700;font-family:Georgia,serif;">🐣 Spring Special</p>
        <p style="margin:0;color:#64748B;font-size:14px;">Book your spring deep clean in April and mention this email for 10% off.</p>
      </div>
      <p style="margin:0 0 20px;color:#0F172A;font-size:15px;line-height:1.65;">We serve Oahu and Maui with the same care we'd give our own homes. Call, text, or tap below to get scheduled. Mahalo! 🌺</p>`,
    ctaText: 'Book spring cleaning',
    ctaUrl: `https://${WEBSITE}`,
  },

  '4th_of_july': {
    defaultSubject: '🎆 4th of July is coming — is your home guest-ready?',
    preheader: 'Get your home sparkling before the holiday.',
    heading: 'Get guest-ready for the 4th 🎆',
    intro: (firstName) => `Aloha ${firstName}! Independence Day is right around the corner — and if you're hosting family or friends, we'd love to help you get your home looking its best.`,
    body: `
      <p style="margin:0 0 16px;color:#0F172A;font-size:15px;line-height:1.65;">Whether it's a backyard barbecue or a full house of guests, a freshly cleaned home makes all the difference. We'll take care of the deep cleaning so you can focus on the fun.</p>
      <div style="background:#FDF7E0;border:1px solid #F2E19B;border-radius:12px;padding:20px 24px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 6px;color:#0F172A;font-size:18px;font-weight:700;font-family:Georgia,serif;">🇺🇸 Holiday Special</p>
        <p style="margin:0;color:#64748B;font-size:14px;">Book before July 3rd and mention this email for priority scheduling.</p>
      </div>
      <p style="margin:0 0 20px;color:#0F172A;font-size:15px;line-height:1.65;">Slots before the holiday fill up fast — call or text us at ${PHONE} or tap below to lock in your date. Mahalo! 🌺</p>`,
    ctaText: 'Reserve my slot',
    ctaUrl: `https://${WEBSITE}`,
  },

  thanksgiving: {
    defaultSubject: '🦃 Thanksgiving is almost here — hosting?',
    preheader: 'Let us handle the cleaning so you can enjoy the holiday.',
    heading: 'Ready for Thanksgiving? 🦃',
    intro: (firstName) => `Aloha ${firstName}! Thanksgiving is just around the corner, and if you're hosting this year, we want to make sure your home is spotless for the occasion.`,
    body: `
      <p style="margin:0 0 16px;color:#0F172A;font-size:15px;line-height:1.65;">Between cooking, decorating, and welcoming guests, cleaning is the last thing you should have to worry about. Let us take it off your plate completely — so you can focus on what matters.</p>
      <div style="background:#EFF9FC;border-radius:12px;padding:20px 24px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 6px;color:#0F172A;font-size:18px;font-weight:700;font-family:Georgia,serif;">🍂 Holiday Prep Special</p>
        <p style="margin:0;color:#64748B;font-size:14px;">Book a pre-Thanksgiving clean before Nov 20th — mention this email for priority placement.</p>
      </div>
      <p style="margin:0 0 20px;color:#0F172A;font-size:15px;line-height:1.65;">Slots go fast this time of year. Call, text, or tap below to get on the schedule. Mahalo for your continued trust — we're grateful for you! 🌺</p>`,
    ctaText: 'Schedule before Thanksgiving',
    ctaUrl: `https://${WEBSITE}`,
  },

  christmas: {
    defaultSubject: '🎄 Mele Kalikimaka — gift yourself a clean home',
    preheader: 'The holidays are here. Let us help you celebrate.',
    heading: 'Mele Kalikimaka! 🎄',
    intro: (firstName) => `Aloha ${firstName}! The holiday season is here, and we'd love to help you welcome it with a beautifully clean home.`,
    body: `
      <p style="margin:0 0 16px;color:#0F172A;font-size:15px;line-height:1.65;">Whether you're hosting Christmas dinner, expecting family from the mainland, or simply want to close out the year fresh — a clean home is the best gift you can give yourself.</p>
      <div style="background:#FDF7E0;border:1px solid #F2E19B;border-radius:12px;padding:20px 24px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 6px;color:#0F172A;font-size:18px;font-weight:700;font-family:Georgia,serif;">🎁 Holiday Gift</p>
        <p style="margin:0;color:#64748B;font-size:14px;">Book a December clean and receive a complimentary aromatherapy finish — our gift to you.</p>
      </div>
      <p style="margin:0 0 20px;color:#0F172A;font-size:15px;line-height:1.65;">December fills up quickly across Oahu and Maui. Call, text, or tap below to get scheduled before slots are gone. Mahalo, and happy holidays! 🌺</p>`,
    ctaText: 'Book holiday cleaning',
    ctaUrl: `https://${WEBSITE}`,
  },
};

// ─── Render a single recipient's email ───────────────────────────────────────
function renderEmail(templateKey, firstName, unsubscribeUrl) {
  const t = HOLIDAY_TEMPLATES[templateKey];
  if (!t) throw new Error(`Unknown template key: ${templateKey}`);

  const BRAND = {
    primary: '#3BB8E3', text: '#0F172A', muted: '#64748B',
    border: '#E2E8F0', tintBlue: '#EFF9FC',
  };
  const LOGO_URL = `${BASE_URL}/hnc-logo.png`;

  const ctaBlock = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0;">
      <tr><td align="center">
        <a href="${t.ctaUrl}" style="display:inline-block;background:${BRAND.primary};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:999px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${t.ctaText}</a>
      </td></tr>
    </table>`;

  const unsubBlock = unsubscribeUrl
    ? `<p style="margin:12px 0 0;font-size:11px;color:#94a3b8;"><a href="${unsubscribeUrl}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a></p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${BUSINESS}</title>
  <style>
    @media (max-width:600px) { .hnc-container { width:100% !important; padding:24px 16px !important; } }
  </style>
</head>
<body style="margin:0;padding:0;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#FFFFFF;">${t.preheader}</div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" class="hnc-container" style="width:600px;max-width:600px;padding:40px 32px;">
        <tr><td align="center" style="padding:8px 0 20px;">
          <img src="${LOGO_URL}" alt="${BUSINESS}" width="180" style="display:block;height:auto;max-width:180px;">
        </td></tr>
        <tr><td align="center" style="padding:0 0 32px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="height:3px;width:48px;background:${BRAND.primary};border-radius:2px;line-height:3px;font-size:1px;">&nbsp;</td></tr>
          </table>
        </td></tr>
        <tr><td>
          <h1 style="margin:0 0 12px;color:${BRAND.text};font-size:24px;font-weight:700;line-height:1.25;font-family:Georgia,'Times New Roman',serif;">${t.heading}</h1>
          <p style="margin:0 0 20px;color:${BRAND.muted};font-size:15px;line-height:1.6;">${t.intro(firstName)}</p>
          ${t.body}
          ${ctaBlock}
        </td></tr>
        <tr><td style="padding:48px 0 0;text-align:center;border-top:1px solid ${BRAND.border};">
          <div style="padding-top:24px;">
            <p style="margin:0 0 6px;color:${BRAND.text};font-size:14px;font-weight:600;font-family:Georgia,serif;">${BUSINESS}</p>
            <p style="margin:0 0 4px;color:${BRAND.muted};font-size:12px;">Oahu &amp; Maui, Hawaii</p>
            <p style="margin:0;color:${BRAND.muted};font-size:12px;">
              <a href="tel:${PHONE.replace(/\D/g,'')}" style="color:${BRAND.primary};text-decoration:none;">${PHONE}</a>
              &nbsp;·&nbsp;
              <a href="https://${WEBSITE}" style="color:${BRAND.primary};text-decoration:none;">${WEBSITE}</a>
            </p>
            ${unsubBlock}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { broadcastId } = req.body || {};
  if (!broadcastId) return res.status(400).json({ error: 'broadcastId is required' });

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // ── Fetch broadcast record ──────────────────────────────────────────────
    const { data: broadcast, error: bErr } = await db
      .from('broadcasts')
      .select('*')
      .eq('id', broadcastId)
      .maybeSingle();

    if (bErr || !broadcast) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    if (broadcast.status === 'sent') {
      return res.status(400).json({ error: 'Broadcast already sent', sentAt: broadcast.sent_at });
    }
    if (!HOLIDAY_TEMPLATES[broadcast.holiday_key]) {
      return res.status(400).json({ error: `Unknown template key: ${broadcast.holiday_key}` });
    }

    // Mark as sending
    await db.from('broadcasts').update({ status: 'sending' }).eq('id', broadcastId);

    // ── Build recipient list ────────────────────────────────────────────────
    const recipients = [];

    if (broadcast.audience === 'leads' || broadcast.audience === 'both') {
      const { data: leads } = await db
        .from('leads')
        .select('id, name, contact_name, email')
        .not('email', 'is', null)
        .eq('do_not_contact', false)
        .is('unsubscribed_at', null);
      (leads || []).forEach(l => {
        if (l.email) recipients.push({
          email: l.email.toLowerCase().trim(),
          name: l.contact_name || l.name || 'there',
          id: l.id,
          type: 'lead',
        });
      });
    }

    if (broadcast.audience === 'clients' || broadcast.audience === 'both') {
      const { data: clients } = await db
        .from('clients')
        .select('id, name, email')
        .not('email', 'is', null)
        .eq('do_not_contact', false)
        .is('unsubscribed_at', null);
      (clients || []).forEach(c => {
        if (c.email) recipients.push({
          email: c.email.toLowerCase().trim(),
          name: c.name || 'there',
          id: c.id,
          type: 'client',
        });
      });
    }

    // Dedupe by email
    const seen = new Set();
    const unique = recipients.filter(r => {
      if (seen.has(r.email)) return false;
      seen.add(r.email);
      return true;
    });

    // Update recipient count
    await db.from('broadcasts').update({ recipient_count: unique.length }).eq('id', broadcastId);

    // ── Fetch already-sent emails for this broadcast ────────────────────────
    const { data: alreadySent } = await db
      .from('broadcast_sends')
      .select('email')
      .eq('broadcast_id', broadcastId);
    const sentEmails = new Set((alreadySent || []).map(s => s.email));

    // ── Send ───────────────────────────────────────────────────────────────
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM = `${BUSINESS} <dane@hawaiinaturalclean.com>`;
    let sent = 0, skipped = 0, failed = 0;

    for (const r of unique) {
      if (sentEmails.has(r.email)) { skipped++; continue; }

      const firstName = (r.name || 'there').split(' ')[0];
      const unsubscribeUrl = `${BASE_URL}/api/unsubscribe?id=${r.id}&type=${r.type}`;

      try {
        const html = renderEmail(broadcast.holiday_key, firstName, unsubscribeUrl);

        const emailRes = await fetchWithTimeout(
          'https://api.resend.com/emails',
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: FROM, to: [r.email], subject: broadcast.subject, html }),
          },
          TIMEOUTS.RESEND
        );

        if (emailRes.ok) {
          await db.from('broadcast_sends').insert({
            broadcast_id: broadcastId,
            email: r.email,
            recipient_id: r.id,
            recipient_type: r.type,
          });
          sent++;
        } else {
          const err = await emailRes.json().catch(() => ({}));
          await logError('send-broadcast', `Resend error for ${r.email}`, { status: emailRes.status, err });
          failed++;
        }
      } catch (err) {
        await logError('send-broadcast', err, { email: r.email, broadcastId });
        failed++;
      }
    }

    // ── Mark complete ──────────────────────────────────────────────────────
    await db.from('broadcasts').update({
      status: failed > 0 && sent === 0 ? 'failed' : 'sent',
      sent_at: new Date().toISOString(),
      sent_count: sent,
    }).eq('id', broadcastId);

    return res.status(200).json({ success: true, broadcastId, sent, skipped, failed, total: unique.length });

  } catch (err) {
    await logError('send-broadcast', err, { broadcastId });
    await db.from('broadcasts').update({ status: 'failed' }).eq('id', broadcastId);
    return res.status(500).json({ error: err.message });
  }
}
