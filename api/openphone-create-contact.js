/**
 * POST /api/openphone-create-contact
 *
 * Creates a contact in OpenPhone so the lead's name appears next to their
 * phone number in the OpenPhone app — and so OpenPhone-side AI features
 * (call summaries, SMS history) attribute conversations to the right person.
 *
 * Mirrors the OpenPhone contact-creation block already used by
 * /api/lead-capture.js (web form path). This endpoint exists so manually-
 * added leads (created via the in-app "New lead" form, which writes directly
 * to Supabase from the frontend) get the same treatment.
 *
 * OpenPhone dedupes contacts by phone number, so calling this on an existing
 * phone is safe — it will return a 4xx that we treat as success.
 *
 * Body:
 *   { name: string, phone: string, email?: string, leadId?: string, company?: string }
 *
 * Returns:
 *   { success: true, dedup?: boolean }   on create or dedup
 *   { success: false, error: string }    on real failure
 */

import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const invalid = validateOrFail(req.body, SCHEMAS.openphoneContact);
  if (invalid) return res.status(400).json(invalid);

  const { name, phone, email, leadId, company } = req.body;

  // Normalize phone to E.164 — same logic as lead-capture.js
  const digits = String(phone).replace(/\D/g, '');
  const e164 = String(phone).startsWith('+') ? String(phone).replace(/[^0-9+]/g, '') : '+1' + digits;

  // Split the name on whitespace so OpenPhone gets a clean firstName/lastName.
  const trimmed = String(name).trim();
  const parts = trimmed.split(/\s+/);
  const firstName = parts[0] || trimmed;
  const lastName = parts.slice(1).join(' ') || undefined;

  const opBody = {
    defaultFields: {
      firstName,
      emails: email ? [{ name: 'email', value: String(email).trim() }] : [],
      phoneNumbers: [{ name: 'phone', value: e164 }],
    },
    source: 'HNC CRM manual lead',
  };
  if (lastName) opBody.defaultFields.lastName = lastName;
  if (company) opBody.defaultFields.company = company;
  if (leadId) opBody.externalId = leadId;

  if (!process.env.QUO_API_KEY) {
    await logError('openphone-create-contact', new Error('QUO_API_KEY not configured'), { phone: e164 });
    return res.status(500).json({ success: false, error: 'OpenPhone API key not configured' });
  }

  try {
    const resp = await fetchWithTimeout(
      'https://api.openphone.com/v1/contacts',
      {
        method: 'POST',
        headers: {
          'Authorization': process.env.QUO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(opBody),
      },
      TIMEOUTS.OPENPHONE
    );

    const text = await resp.text();
    console.log('[openphone-create-contact]', resp.status, text.slice(0, 200));

    if (resp.ok) {
      return res.status(200).json({ success: true });
    }

    // OpenPhone returns 409/422 on duplicates depending on account config.
    // Treat any 4xx as a soft success — the contact effectively exists.
    if (resp.status >= 400 && resp.status < 500) {
      return res.status(200).json({ success: true, dedup: true });
    }

    throw new Error('OpenPhone responded ' + resp.status + ': ' + text.slice(0, 200));
  } catch (err) {
    await logError('openphone-create-contact', err, { phone: e164, leadId });
    return res.status(500).json({ success: false, error: err.message });
  }
}
