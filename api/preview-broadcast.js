/**
 * POST /api/preview-broadcast
 *
 * Renders the actual email HTML that recipients will see — without sending
 * anything. Used by the broadcast modal's "Preview email" button so Dane can
 * see exactly what the email will look like before scheduling/sending.
 *
 * Body (one of):
 *   { broadcastId: string }                  — preview an already-saved broadcast
 *   { holiday_key: string,                   — preview an unsaved/draft broadcast
 *     subject: string,                         (matches the shape of a broadcasts row)
 *     custom_preheader, custom_heading, custom_intro,
 *     custom_body_html, custom_cta_text, custom_cta_url,
 *     firstName?: string }
 *
 * Returns:
 *   text/html — the rendered email, ready to display in an iframe or new tab
 */

import { createClient } from '@supabase/supabase-js';
import { resolveTemplate, renderEmail } from './send-broadcast.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    let broadcast;

    if (body.broadcastId) {
      // Hydrate from DB
      const db = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } }
      );
      const { data, error } = await db
        .from('broadcasts')
        .select('*')
        .eq('id', body.broadcastId)
        .maybeSingle();
      if (error || !data) return res.status(404).json({ error: 'Broadcast not found' });
      broadcast = data;
    } else {
      // Build a synthetic broadcast object from the body — useful for previewing
      // a draft that hasn't been saved yet (e.g. right after AI generation)
      broadcast = {
        holiday_key:      body.holiday_key,
        subject:          body.subject || '(no subject)',
        custom_preheader: body.custom_preheader || null,
        custom_heading:   body.custom_heading   || null,
        custom_intro:     body.custom_intro     || null,
        custom_body_html: body.custom_body_html || null,
        custom_cta_text:  body.custom_cta_text  || null,
        custom_cta_url:   body.custom_cta_url   || null,
      };
    }

    const template = resolveTemplate(broadcast);
    if (!template) {
      return res.status(400).json({
        error: `Cannot resolve template (holiday_key=${broadcast.holiday_key}). For ai_custom, custom_body_html must be set.`,
      });
    }

    // Use a placeholder name for the preview so the recipient sees how
    // {firstName} interpolation will look. Default to "Dane" since this is
    // his preview, but allow override via body.
    const firstName = body.firstName || 'Dane';
    // No unsubscribe link in previews — keeps the focus on the content
    const html = renderEmail(template, firstName, null);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[preview-broadcast]', err);
    return res.status(500).json({ error: err.message });
  }
}
