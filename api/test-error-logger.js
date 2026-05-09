// api/test-error-logger.js
//
// Diagnostic-system smoke test. Writes a test row to error_logs so Dane
// can verify the Recent Errors panel actually displays new errors.
//
// Created 2026-05-08 as part of locking down the diagnostic system. The
// frontend error logger (commit efb56f0) and Recent Errors panel
// (commit 5dd1228) were never tested end-to-end — this endpoint provides
// a low-stakes way to confirm the full pipeline (write → query → render)
// is functional before we rely on it for real bug reports.
//
// Usage:
//   POST /api/test-error-logger
//   Body: { variant?: "frontend" | "backend" }  (default: backend)
//   Response: { ok: true, source: "...", message: "..." }
//
// Then: open Settings → Recent errors → Refresh → confirm the test row
// appears at the top.

import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const variant = (req.body && req.body.variant) || 'backend';
  const ts = new Date().toISOString();
  const message = `Diagnostic system test — ${variant} variant @ ${ts}`;

  try {
    await logError(
      'test-error-logger',
      message,
      { test: true, variant: variant, timestamp: ts },
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    return res.status(200).json({
      ok: true,
      source: 'test-error-logger',
      message: message,
      next_step: 'Open Settings → Recent errors → click Refresh. The row should appear at the top within seconds.',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
