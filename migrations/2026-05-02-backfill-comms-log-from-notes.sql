-- ──────────────────────────────────────────────────────────────────────
-- Backfill lead_comms_log from historical AI follow-up entries that
-- were appended to lead.notes BEFORE the lead_comms_log table existed.
--
-- Run this AFTER running 2026-05-02-add-lead-comms-log.sql.
--
-- What it does:
--   • Scans every lead's notes field for lines like:
--       [May 2, 10:42 PM] AI follow-up sent (SMS)
--       [May 2, 10:42 PM] AI follow-up sent (SMS + Email)
--       [Apr 28, 9:15 AM]  AI follow-up sent (Email)
--   • For each match, parses the timestamp (assumed Hawaii time, current
--     year — safe since this feature was built today) and the channel(s).
--   • Inserts one row into lead_comms_log per channel sent.
--   • Marked with source_label = 'AI follow-up (backfilled from notes)' so
--     you can distinguish historical from real-time entries in the panel.
--
-- Idempotent: re-running won't create duplicates because of the NOT EXISTS
-- guard at the bottom (matches by lead_id + parsed sent_at + channel).
-- ──────────────────────────────────────────────────────────────────────

WITH extracted AS (
  -- Pull every "[stamp] AI follow-up sent (channels)" match out of notes
  SELECT
    l.id              AS lead_id,
    parts[1]          AS raw_stamp,           -- e.g. "May 2, 10:42 PM"
    trim(parts[2])    AS channels_text        -- e.g. "SMS" or "SMS + Email"
  FROM leads l,
       regexp_matches(
         l.notes,
         '\[([^\]]+)\] AI follow-up sent \(([^)]+)\)',
         'g'
       ) AS parts
  WHERE l.notes LIKE '%AI follow-up sent%'
),
parsed AS (
  -- Convert "May 2, 10:42 PM" + current year into a real Hawaii-time timestamp
  SELECT
    lead_id,
    channels_text,
    raw_stamp,
    -- Parse the localized stamp + assume current year + Hawaii timezone
    (to_timestamp(
       raw_stamp || ' ' || EXTRACT(YEAR FROM CURRENT_DATE)::text,
       'Mon FMDD, FMHH12:MI AM YYYY'
     ) AT TIME ZONE 'Pacific/Honolulu') AS sent_at
  FROM extracted
),
expanded AS (
  -- Split "SMS + Email" into one row per channel
  SELECT
    p.lead_id,
    p.sent_at,
    CASE
      WHEN lower(trim(ch)) = 'sms'   THEN 'sms'
      WHEN lower(trim(ch)) = 'email' THEN 'email'
      ELSE NULL
    END AS channel
  FROM parsed p
  CROSS JOIN LATERAL unnest(string_to_array(p.channels_text, '+')) AS ch
)
INSERT INTO lead_comms_log (lead_id, channel, kind, status, source_label, sent_at)
SELECT
  e.lead_id,
  e.channel,
  'ai_followup',
  'sent',
  'AI follow-up (backfilled from notes)',
  e.sent_at
FROM expanded e
WHERE e.channel IS NOT NULL
  AND NOT EXISTS (
    -- Don't double-insert if a real-time row already exists for this same
    -- lead + channel within a 5-minute window of the parsed timestamp.
    SELECT 1 FROM lead_comms_log existing
    WHERE existing.lead_id = e.lead_id
      AND existing.channel = e.channel
      AND existing.kind = 'ai_followup'
      AND ABS(EXTRACT(EPOCH FROM (existing.sent_at - e.sent_at))) < 300
  );

-- Verify: count what was inserted
SELECT
  source_label,
  channel,
  COUNT(*) AS rows
FROM lead_comms_log
WHERE source_label = 'AI follow-up (backfilled from notes)'
GROUP BY source_label, channel
ORDER BY channel;
