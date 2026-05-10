-- 2026-05-10 — manual-send audit columns: review-request and
-- invoice-resent on the clients table.
--
-- Powers the new client-profile manual notifications panel:
--   - Send waiver SMS (reuses existing clients.policy_reminder_sent_at)
--   - Send review request email/SMS → writes review_request_sent_at + _by
--   - Resend last invoice email/SMS → writes invoice_resent_at + _by
--
-- Per-action timestamps (not per-channel) — activity_logs preserves
-- which channel was used. Keeps the column count small.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS review_request_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_request_sent_by UUID,
  ADD COLUMN IF NOT EXISTS invoice_resent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoice_resent_by      UUID;

COMMENT ON COLUMN clients.review_request_sent_at IS 'Last manual review-request send (any channel) — display in client-profile panel';
COMMENT ON COLUMN clients.review_request_sent_by IS 'Auth user who triggered the review-request manual send';
COMMENT ON COLUMN clients.invoice_resent_at      IS 'Last manual invoice-resend send (any channel) — display in client-profile panel';
COMMENT ON COLUMN clients.invoice_resent_by      IS 'Auth user who triggered the invoice resend';
