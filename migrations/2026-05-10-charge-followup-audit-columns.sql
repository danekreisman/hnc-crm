-- 2026-05-10 — charge follow-up audit columns on appointments.
--
-- New "post-clean follow-up SMS" check-box on the unified Charge
-- modal. Sends a templated message after the charge/invoice action
-- succeeds, confirming what was charged and pointing to the next
-- scheduled appointment (when one exists).
--
-- Audit column is per-appointment (not per-client) because the
-- relevant context is "did we send the follow-up FOR this clean?"
-- not "did this client ever get a follow-up?"

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS charge_followup_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS charge_followup_sent_by UUID;

COMMENT ON COLUMN appointments.charge_followup_sent_at IS 'Last post-charge follow-up SMS send for this appointment';
COMMENT ON COLUMN appointments.charge_followup_sent_by IS 'Auth user who triggered the post-charge follow-up SMS';
