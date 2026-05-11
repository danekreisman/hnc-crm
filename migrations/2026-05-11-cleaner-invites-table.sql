-- 2026-05-11 — cleaner_invites table for auto-assign-on-YES feature.
--
-- Background: Dane sends job invites to N cleaners; cleaners reply via SMS.
-- The webhook needs to know which appointment a "YES" is responding to,
-- and we need to atomically prevent two cleaners both grabbing the same
-- slot (race condition).
--
-- Design (per 2026-05-11 conversation with Dane):
--   - One row per (appointment, invited_cleaner). Created at invite-send time.
--   - status: 'pending' → 'accepted' | 'declined' | 'missed' | 'cancelled'
--       pending   = invite sent, no reply yet
--       accepted  = cleaner replied YES, won the race
--       declined  = cleaner replied NO
--       missed    = someone else won; this cleaner replied YES too late
--                   (or didn't reply at all and slot was filled)
--       cancelled = appointment cancelled / Dane manually re-assigned away
--   - responded_at: when their YES/NO came in (null while pending)
--
-- The atomic-assign check uses the appointments row itself:
--   UPDATE appointments SET cleaner_id = $1, status = 'assigned'
--   WHERE id = $appt AND cleaner_id IS NULL;
-- → if 0 rows affected, this cleaner lost the race. They get the
--   "sorry already assigned" SMS, and their invite row is marked 'missed'.
--
-- Multi-invite handling (option A from 2026-05-11 design): if a cleaner
-- has multiple pending invites and replies "YES" with no specifier, the
-- webhook picks the most recently sent_at. Wrong-job cases handled by
-- Dane manually fixing in the UI (low-frequency edge case).

CREATE TABLE IF NOT EXISTS cleaner_invites (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  UUID            NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  cleaner_id      UUID            NOT NULL REFERENCES cleaners(id) ON DELETE CASCADE,
  sent_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  status          TEXT            NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','declined','missed','cancelled')),
  responded_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- Lookup: find pending invites for a cleaner (the webhook's hot path on
-- every inbound SMS). Filtered to recent + pending to keep the planner happy.
CREATE INDEX IF NOT EXISTS idx_cleaner_invites_cleaner_status
  ON cleaner_invites (cleaner_id, status, sent_at DESC);

-- Lookup: all invites for one appointment (display "who's pending" on
-- the appointment overlay).
CREATE INDEX IF NOT EXISTS idx_cleaner_invites_appointment
  ON cleaner_invites (appointment_id, status);

COMMENT ON TABLE cleaner_invites IS 'Tracks job invites sent to cleaners + their YES/NO replies. Drives auto-assign-on-YES.';
COMMENT ON COLUMN cleaner_invites.status IS 'pending → accepted/declined/missed/cancelled';
COMMENT ON COLUMN cleaner_invites.responded_at IS 'When the cleaner replied (null while pending or for "missed" auto-set when slot filled).';
