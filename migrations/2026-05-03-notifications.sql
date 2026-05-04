-- HNC CRM: notifications table (2026-05-03)
-- In-app notification feed for admin users. Phase 1 events: invoice_paid,
-- tip_received, booking_created. Future phases: lead_inquiry, task_overdue,
-- booking_cancelled, plus PWA push and SMS dispatch layered on top.
--
-- target_email NULL = broadcast to all admins (each admin sees the row).
-- target_email = '<email>' = directed to that specific person.
-- read_at NULL = unread. SET when user clicks the notification.

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  title text NOT NULL,
  body text,
  url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_email text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Recent-feed query: ORDER BY created_at DESC LIMIT N
CREATE INDEX IF NOT EXISTS notifications_created_idx
  ON public.notifications (created_at DESC);

-- Unread-count query: WHERE (target_email = X OR target_email IS NULL) AND read_at IS NULL
-- Partial index keeps it small even if read_at history grows huge.
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON public.notifications (target_email, created_at DESC)
  WHERE read_at IS NULL;
