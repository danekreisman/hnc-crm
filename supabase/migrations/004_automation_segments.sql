-- 004_automation_segments.sql
-- Adds segment tracking and automation execution support
-- Date: April 22, 2026

-- ============================================================================
-- 1. ENHANCE LEADS TABLE (Add segment tracking)
-- ============================================================================

alter table public.leads
  add column if not exists segment text not null default 'initial_sequence', -- new_lead, initial_sequence, nurture, hot_lead, converted, lost, one_time, reengagement, winback, blacklist
  add column if not exists segment_moved_at timestamptz default now(),
  add column if not exists response_count integer not null default 0,
  add column if not exists last_responded_at timestamptz,
  add column if not exists booking_count_6m integer not null default 0, -- bookings in last 6 months
  add column if not exists first_booking_date date,
  add column if not exists last_booking_date date,
  add column if not exists last_automation_run_at timestamptz, -- prevent duplicate automation runs
  add column if not exists blacklist_reason text; -- "bad_experience", "moved", etc.

create index if not exists leads_segment_idx on public.leads(segment);
create index if not exists leads_response_count_idx on public.leads(response_count);
create index if not exists leads_last_responded_idx on public.leads(last_responded_at);
create index if not exists leads_booking_count_idx on public.leads(booking_count_6m);

-- ============================================================================
-- 2. AUTOMATIONS CONFIGURATION TABLE (Pre-built + custom)
-- ============================================================================

-- Already created in 002, but adding reference here for clarity

-- ============================================================================
-- 3. AUTOMATION INSTANCE TRACKING (Which automations are "running" on which leads)
-- ============================================================================

create table if not exists public.lead_automation_state (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  automation_id uuid not null references public.lead_automations(id) on delete cascade,
  
  -- State tracking
  status text not null default 'active', -- active, paused, completed, skipped
  
  -- Action tracking
  current_action_index integer not null default 0, -- which action in the sequence are we on?
  next_action_at timestamptz, -- when should we execute the next action?
  actions_completed jsonb not null default '[]'::jsonb, -- [{action_index: 0, completed_at: '...', status: 'success'}]
  
  -- Metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  constraint unique_active_automation unique (lead_id, automation_id, status) 
    where status = 'active'
);

create index if not exists las_lead_id_idx on public.lead_automation_state(lead_id);
create index if not exists las_automation_idx on public.lead_automation_state(automation_id);
create index if not exists las_status_idx on public.lead_automation_state(status);
create index if not exists las_next_action_idx on public.lead_automation_state(next_action_at);

-- ============================================================================
-- 4. RESPONSES TABLE (Track when leads respond to automations)
-- ============================================================================

create table if not exists public.lead_responses (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  
  -- Source of response
  channel text not null, -- 'sms', 'email', 'call', 'booking'
  
  -- Content
  content text, -- The actual message/note
  
  -- Metadata
  created_at timestamptz not null default now(),
  received_from text, -- phone number, email, etc
  automation_id uuid references public.lead_automations(id) on delete set null -- which automation did they respond to?
);

create index if not exists lr_lead_id_idx on public.lead_responses(lead_id);
create index if not exists lr_channel_idx on public.lead_responses(channel);
create index if not exists lr_created_idx on public.lead_responses(created_at desc);
create index if not exists lr_automation_idx on public.lead_responses(automation_id);

-- ============================================================================
-- 5. NOTES
-- ============================================================================
--
-- Segments:
--   new_lead         - Just created, before any automation
--   initial_sequence - In the 7-day initial follow-up sequence
--   hot_lead         - Responded or engaged, awaiting manual follow-up
--   converted        - Became a customer (booked)
--   lost             - Explicitly rejected
--   one_time         - Booked once, hasn't rebooked in 90+ days
--   reengagement     - In the re-engagement sequence (post-booking)
--   winback          - Canceled customer, in slow win-back sequence
--   blacklist        - Do not contact
--
-- Automation execution:
--   - lead_automation_state tracks which automations are "running" on which leads
--   - Prevents same automation from running twice on same lead
--   - Tracks which action in the sequence is next
--   - next_action_at is when the cron job should execute
--
