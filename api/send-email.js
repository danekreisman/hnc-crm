import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

/**
 * Branded Email Shell for Hawaii Natural Clean
 *
 * Every email uses this shell so the look is consistent across all templates.
 * Brand colors:
 *   Primary blue:    #3BB8E3
 *   Mid blue:        #59C7E2
 *   Light blue:      #79D3E1
 *   Pale blue tint:  #A5E6E9
 *   Accent gold:     #F2E19B
 *   Text dark:       #0F172A
 *   Text muted:      #64748B
 *   Border soft:     #E2E8F0
 *   Background:      #FFFFFF  (white — the main brand color)
 */

const BRAND = {
  primary:   '#3BB8E3',
  mid:       '#59C7E2',
  light:     '#79D3E1',
  pale:      '#A5E6E9',
  gold:      '#F2E19B',
  text:      '#0F172A',
  muted:     '#64748B',
  border:    '#E2E8F0',
  tintBlue:  '#EFF9FC',  // very subtle blue tint for info boxes
  tintGold:  '#FDF7E0',  // very subtle gold tint for offer boxes
};

const LOGO_URL     = 'https://hnc-crm.vercel.app/hnc-logo.png';
const BUSINESS     = 'Hawaii Natural Clean';
const PHONE        = '(808) 468-5356';
const WEBSITE      = 'hawaiinaturalclean.com';
const REGION       = 'Oahu & Maui, Hawaii';

/**
 * Branded email shell — wraps any content in the HNC visual identity.
 *
 * @param {object} opts
 * @param {string} opts.preheader  - Hidden preview text (first line in inbox previews)
 * @param {string} opts.heading    - Main heading shown in the body
 * @param {string} opts.intro      - Optional intro paragraph under the heading
 * @param {string} opts.bodyHtml   - Core content (HTML allowed)
 * @param {string} opts.ctaText    - Optional CTA button text
 * @param {string} opts.ctaUrl     - Optional CTA button URL
 * @param {string} opts.footnote   - Optional small note above the footer
 */
function renderBrandedEmail({ preheader = '', heading = '', intro = '', bodyHtml = '', ctaText = '', ctaUrl = '', footnote = '' }) {
  const ctaBlock = (ctaText && ctaUrl) ? `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0;">
      <tr><td align="center">
        <a href="${ctaUrl}" style="display:inline-block;background:${BRAND.primary};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:999px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:.01em;">${ctaText}</a>
      </td></tr>
    </table>` : '';

  const footnoteBlock = footnote ? `
    <p style="margin:28px 0 0;padding:16px;background:${BRAND.tintBlue};border-radius:10px;color:${BRAND.muted};font-size:13px;line-height:1.55;">${footnote}</p>` : '';

  const introBlock = intro ? `
    <p style="margin:0 0 20px;color:${BRAND.muted};font-size:15px;line-height:1.6;">${intro}</p>` : '';

  const headingBlock = heading ? `
    <h1 style="margin:0 0 12px;color:${BRAND.text};font-size:24px;font-weight:700;line-height:1.25;letter-spacing:-0.01em;font-family:Georgia,'Times New Roman',serif;">${heading}</h1>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${BUSINESS}</title>
  <style>
    @media (max-width:600px) {
      .hnc-container { width:100% !important; padding:24px 16px !important; }
      .hnc-card { padding:28px 20px !important; }
      .hnc-heading { font-size:22px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <!-- Preheader (hidden in body, shown in inbox preview) -->
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#FFFFFF;opacity:0;">${preheader}</div>

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#FFFFFF;">
    <tr>
      <td align="center" style="padding:0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" class="hnc-container" style="width:600px;max-width:600px;padding:40px 32px;">

          <!-- Logo header -->
          <tr>
            <td align="center" style="padding:8px 0 20px;">
              <img src="${LOGO_URL}" alt="${BUSINESS}" width="180" style="display:block;height:auto;max-width:180px;border:0;">
            </td>
          </tr>

          <!-- Accent rule -->
          <tr>
            <td align="center" style="padding:0 0 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="height:3px;width:48px;background:${BRAND.primary};border-radius:2px;line-height:3px;font-size:1px;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content card -->
          <tr>
            <td class="hnc-card" style="padding:0;">
              ${headingBlock}
              ${introBlock}
              ${bodyHtml}
              ${ctaBlock}
              ${footnoteBlock}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:48px 0 0;text-align:center;border-top:1px solid ${BRAND.border};margin-top:48px;">
              <div style="padding-top:24px;">
                <p style="margin:0 0 6px;color:${BRAND.text};font-size:14px;font-weight:600;font-family:Georgia,serif;letter-spacing:.02em;">${BUSINESS}</p>
                <p style="margin:0 0 4px;color:${BRAND.muted};font-size:12px;">${REGION}</p>
                <p style="margin:0;color:${BRAND.muted};font-size:12px;">
                  <a href="tel:${PHONE.replace(/\D/g, '')}" style="color:${BRAND.primary};text-decoration:none;">${PHONE}</a>
                  &nbsp;·&nbsp;
                  <a href="https://${WEBSITE}" style="color:${BRAND.primary};text-decoration:none;">${WEBSITE}</a>
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
}

// ─── Helper: build a two-column detail row (label + value) ─────────────────────
function detailRow(label, value) {
  return `<tr>
    <td style="padding:10px 0;color:${BRAND.muted};font-size:14px;vertical-align:top;width:40%;">${label}</td>
    <td style="padding:10px 0;color:${BRAND.text};font-size:14px;font-weight:500;text-align:right;">${value}</td>
  </tr>`;
}

// ─── Helper: card container with optional title ────────────────────────────────
function card(title, innerHtml) {
  const titleBlock = title ? `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.muted};margin-bottom:14px;">${title}</div>` : '';
  return `<div style="background:#FFFFFF;border:1px solid ${BRAND.border};border-radius:14px;padding:24px;margin:0 0 20px;">
    ${titleBlock}
    ${innerHtml}
  </div>`;
}

// ─── Helper: offer / highlight box ─────────────────────────────────────────────
function offerBox(heading, body) {
  return `<div style="background:${BRAND.tintGold};border:1px solid ${BRAND.gold};border-radius:12px;padding:20px 24px;margin:0 0 20px;text-align:center;">
    <p style="margin:0 0 6px;color:${BRAND.text};font-size:18px;font-weight:700;font-family:Georgia,serif;">${heading}</p>
    <p style="margin:0;color:${BRAND.muted};font-size:13px;">${body}</p>
  </div>`;
}

// ─── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let to, subject, type;
  try {
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = `${BUSINESS} <dane@hawaiinaturalclean.com>`;

    ({ to, subject, type } = req.body);
    const {
      clientName, amount, service, date, time, cleaner,
      invoiceUrl, terms, notes, bookingUrl,
    } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ success: false, error: 'to and subject are required' });
    }

    const firstName = (clientName || '').split(' ')[0] || 'there';
    let html = '';

    // ─── INVOICE ─────────────────────────────────────────────────────────────
    if (type === 'invoice') {
      const detailTable = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${detailRow('Service',  service || 'Cleaning service')}
        ${detailRow('Date',     date || '')}
        ${detailRow('Terms',    terms || 'Due now')}
        <tr><td colspan="2" style="padding:8px 0;border-top:1px solid ${BRAND.border};"></td></tr>
        <tr>
          <td style="padding:10px 0;font-size:16px;font-weight:700;color:${BRAND.text};">Total</td>
          <td style="padding:10px 0;font-size:20px;font-weight:800;color:${BRAND.primary};text-align:right;font-family:Georgia,serif;">${amount || ''}</td>
        </tr>
      </table>`;

      html = renderBrandedEmail({
        preheader: `Your invoice for ${service || 'cleaning services'} from ${BUSINESS}`,
        heading: 'Your invoice is ready',
        intro: `Aloha ${firstName} — here's your invoice for recent cleaning services. Mahalo for choosing us!`,
        bodyHtml:
          card('Invoice details', detailTable) +
          `<div style="background:${BRAND.tintBlue};border-radius:10px;padding:16px 18px;margin:0 0 20px;">
            <p style="margin:0 0 6px;color:${BRAND.text};font-size:13px;font-weight:600;">Payment options</p>
            <p style="margin:0;color:${BRAND.muted};font-size:13px;line-height:1.6;">
              ✓ ACH bank transfer — <strong style="color:${BRAND.text};">free</strong> (3–5 business days)<br>
              ✓ Credit or debit card — 3% processing fee applied
            </p>
          </div>` +
          (notes ? `<p style="margin:0 0 20px;color:${BRAND.muted};font-size:14px;line-height:1.6;">${notes}</p>` : ''),
        ctaText:   invoiceUrl ? 'View & pay invoice' : '',
        ctaUrl:    invoiceUrl || '',
        footnote:  `Questions? Reply to this email or call <a href="tel:${PHONE.replace(/\D/g,'')}" style="color:${BRAND.primary};text-decoration:none;">${PHONE}</a>.`,
      });
    }

    // ─── APPOINTMENT REMINDER ───────────────────────────────────────────────
    else if (type === 'reminder') {
      const detailTable = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${detailRow('Service', service || 'Cleaning')}
        ${detailRow('Date',    date || '')}
        ${detailRow('Time',    time || '')}
        ${detailRow('Cleaner', cleaner || 'Your HNC team')}
      </table>`;

      html = renderBrandedEmail({
        preheader: `Reminder: your cleaning is coming up`,
        heading: 'Your appointment is coming up',
        intro: `Aloha ${firstName} — just a friendly reminder about your upcoming cleaning.`,
        bodyHtml:
          card('Appointment details', detailTable) +
          `<p style="margin:0 0 20px;color:${BRAND.muted};font-size:14px;line-height:1.65;">A few things that help us do our best work: please tidy clutter from surfaces, do or put away dishes, and secure any pets before we arrive.</p>`,
        footnote: `Need to reschedule? Reply here or text us at <a href="tel:${PHONE.replace(/\D/g,'')}" style="color:${BRAND.primary};text-decoration:none;">${PHONE}</a>.`,
      });
    }

    // ─── JOB COMPLETE / THANK YOU + REVIEW ──────────────────────────────────
    else if (type === 'thankyou') {
      html = renderBrandedEmail({
        preheader: `How did we do, ${firstName}?`,
        heading: `Mahalo, ${firstName}! 🌺`,
        intro: `Your home has been freshly cleaned. We hope it feels wonderful to come home to.`,
        bodyHtml:
          `<p style="margin:0 0 24px;color:${BRAND.text};font-size:15px;line-height:1.65;">If you have a moment, we'd be so grateful for a quick Google review. It means the world to a local Hawaii business and helps us serve more families across the islands.</p>`,
        ctaText: 'Leave a Google review',
        ctaUrl:  'https://g.page/r/hawaiinaturalclean/review',
        footnote: `Any feedback — good or otherwise — reply here and Dane will read it personally.`,
      });
    }

    // ─── PAYMENT RECEIPT ────────────────────────────────────────────────────
    else if (type === 'receipt') {
      const detailTable = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${detailRow('Service', service || 'Cleaning')}
        ${detailRow('Date',    date || '')}
        <tr><td colspan="2" style="padding:8px 0;border-top:1px solid ${BRAND.border};"></td></tr>
        <tr>
          <td style="padding:10px 0;font-size:16px;font-weight:700;color:${BRAND.text};">Paid</td>
          <td style="padding:10px 0;font-size:20px;font-weight:800;color:${BRAND.primary};text-align:right;font-family:Georgia,serif;">${amount || ''}</td>
        </tr>
      </table>`;

      html = renderBrandedEmail({
        preheader: `Payment received — mahalo!`,
        heading: 'Payment received',
        intro: `Aloha ${firstName} — we've received your payment. Mahalo!`,
        bodyHtml: card('Receipt', detailTable),
        footnote: `See you at your next clean. Any questions, just reply here.`,
      });
    }

    // ─── REACTIVATION / WIN-BACK ────────────────────────────────────────────
    else if (type === 'reactivation') {
      html = renderBrandedEmail({
        preheader: `We miss you — here's a little something`,
        heading: `We'd love to see you again`,
        intro: `Aloha ${firstName} — it's been a while, and we wanted to check in.`,
        bodyHtml:
          offerBox('10% off your next clean', 'One-time offer · reply to book') +
          `<p style="margin:0 0 20px;color:${BRAND.muted};font-size:14px;line-height:1.65;">Homes change, schedules shift, and life happens. Whenever you're ready for a refresh, we're here.</p>`,
        ctaText: 'Book my next clean',
        ctaUrl:  `https://${WEBSITE}`,
        footnote: `Or simply reply to this email and we'll take care of the rest. Mahalo!`,
      });
    }

    // ─── QUOTE ──────────────────────────────────────────────────────────────
    else if (type === 'quote') {
      const { quoteData, frequency, bookingUrl, bookingToken, customIntro } = req.body;
      const q = quoteData || {};
      const bk = q.breakdown || {};

      // Quote summary table
      const summaryRows = [];
      summaryRows.push(detailRow('Service', service || 'Cleaning'));
      if (frequency)         summaryRows.push(detailRow('Frequency', frequency));
      if (q.duration_minutes) summaryRows.push(detailRow('Est. duration', `${q.duration_minutes} min`));
      const summaryTable = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${summaryRows.join('')}</table>`;

      // Price breakdown table
      const priceRows = [];
      if (bk.bedrooms)  priceRows.push(detailRow(bk.bedrooms.tier,  `$${Number(bk.bedrooms.price).toFixed(2)}`));
      if (bk.bathrooms) priceRows.push(detailRow(bk.bathrooms.tier, `$${Number(bk.bathrooms.price).toFixed(2)}`));
      if (bk.sqft)      priceRows.push(detailRow(bk.sqft.tier,      `$${Number(bk.sqft.price).toFixed(2)}`));
      if (bk.condition && bk.condition.surcharge > 0) {
        priceRows.push(detailRow(`Condition surcharge (${bk.condition.tier})`, `+$${Number(bk.condition.surcharge).toFixed(2)}`));
      }
      if (q.subtotal !== q.total) {
        priceRows.push(`<tr><td colspan="2" style="padding:4px 0;border-top:1px solid ${BRAND.border};"></td></tr>`);
        priceRows.push(detailRow('Subtotal', `$${Number(q.subtotal).toFixed(2)}`));
      }
      if (q.discount_pct > 0) {
        priceRows.push(`<tr>
          <td style="padding:10px 0;color:${BRAND.primary};font-size:14px;font-weight:500;">${frequency || 'Frequency'} discount (${q.discount_pct}% off)</td>
          <td style="padding:10px 0;color:${BRAND.primary};font-size:14px;font-weight:600;text-align:right;">−$${Number(q.discount).toFixed(2)}</td>
        </tr>`);
      }
      priceRows.push(`<tr><td colspan="2" style="padding:8px 0;border-top:2px solid ${BRAND.text};"></td></tr>`);
      priceRows.push(`<tr>
        <td style="padding:10px 0;font-size:18px;font-weight:700;color:${BRAND.text};">Total</td>
        <td style="padding:10px 0;font-size:24px;font-weight:800;color:${BRAND.primary};text-align:right;font-family:Georgia,serif;">$${Number(q.total).toFixed(2)}</td>
      </tr>`);
      const priceTable = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${priceRows.join('')}</table>`;

      const finalBookUrl = bookingToken
        ? `https://hnc-crm.vercel.app/book.html?bt=${bookingToken}`
        : (bookingUrl || 'https://hnc-crm.vercel.app/book.html');

      html = renderBrandedEmail({
        preheader: `Your quote from ${BUSINESS} — ready to book`,
        heading: `Your quote is ready 🌺`,
        intro: customIntro || `Aloha ${firstName} — mahalo for reaching out. Here's your personalized quote.`,
        bodyHtml:
          card('Service summary', summaryTable) +
          card('Price breakdown', priceTable),
        ctaText: 'Book now',
        ctaUrl:  finalBookUrl,
        footnote: `Questions or want to adjust? Call or text <a href="tel:${PHONE.replace(/\D/g,'')}" style="color:${BRAND.primary};text-decoration:none;">${PHONE}</a> or reply to this email. We'll make it right.`,
      });
    }

    // ─── LEAD FOLLOW-UP ─────────────────────────────────────────────────────
    else if (type === 'lead_followup') {
      html = renderBrandedEmail({
        preheader: `Just checking in on your quote`,
        heading: `Still thinking it over?`,
        intro: `Aloha ${firstName} — wanted to check in on the quote we sent.`,
        bodyHtml:
          (notes ? `<p style="margin:0 0 20px;color:${BRAND.text};font-size:15px;line-height:1.65;">${notes}</p>` : `<p style="margin:0 0 20px;color:${BRAND.text};font-size:15px;line-height:1.65;">No pressure at all — just wanted to see if you had any questions or if there's anything we can adjust to make it work for you.</p>`),
        ctaText: `Reply to book`,
        ctaUrl:  `mailto:dane@hawaiinaturalclean.com`,
        footnote: `Or call/text <a href="tel:${PHONE.replace(/\D/g,'')}" style="color:${BRAND.primary};text-decoration:none;">${PHONE}</a>. Mahalo!`,
      });
    }

    // ─── UNPAID INVOICE REMINDER ────────────────────────────────────────────
    else if (type === 'invoice_reminder') {
      html = renderBrandedEmail({
        preheader: `A friendly reminder about your invoice`,
        heading: `Friendly invoice reminder`,
        intro: `Aloha ${firstName} — a quick note that we have an unpaid invoice on file.`,
        bodyHtml: `<p style="margin:0 0 20px;color:${BRAND.text};font-size:15px;line-height:1.65;">${notes || `If you've already sent payment, mahalo — you can ignore this. Otherwise, the link below will take you to the invoice.`}</p>`,
        ctaText: invoiceUrl ? 'View invoice' : '',
        ctaUrl:  invoiceUrl || '',
        footnote: `If there's an issue or you'd like to arrange something different, just reply here. No hassle.`,
      });
    }

    // ─── GENERIC (used by automation test emails and ad-hoc sends) ──────────
    else {
      // The "notes" field holds the message content. We render it cleanly with
      // paragraph breaks preserved. Uses the heading-free mode for a clean look.
      const body = (notes || '')
        .split(/\n\s*\n/)
        .map(p => `<p style="margin:0 0 16px;color:${BRAND.text};font-size:15px;line-height:1.65;">${p.replace(/\n/g, '<br>')}</p>`)
        .join('');

      html = renderBrandedEmail({
        preheader: subject,
        heading: '',
        intro: '',
        bodyHtml: body || `<p style="margin:0;color:${BRAND.text};font-size:15px;line-height:1.65;">${subject}</p>`,
        ctaText:  bookingUrl ? 'Book now' : '',
        ctaUrl:   bookingUrl || '',
        footnote: `Reply here or text <a href="tel:${PHONE.replace(/\D/g,'')}" style="color:${BRAND.primary};text-decoration:none;">${PHONE}</a> anytime. Mahalo!`,
      });
    }

    const response = await fetchWithTimeout(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html })
      },
      TIMEOUTS.RESEND
    );

    const data = await response.json();

    if (response.ok) {
      return res.status(200).json({ success: true, id: data.id });
    } else {
      await logError('send-email', `Resend API error: ${response.status}`, { to, subject, error: data });
      return res.status(400).json({ success: false, error: data });
    }
  } catch (err) {
    await logError('send-email', err, { to, subject, type });
    return res.status(500).json({ success: false, error: err.message });
  }
}
