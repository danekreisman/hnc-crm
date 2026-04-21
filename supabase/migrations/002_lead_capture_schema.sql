-- 002_lead_capture_schema.sql
-- Adds lead automation & capture form support
-- Date: April 20, 2026

-- ============================================================================
-- 1. LEAD SOURCES TABLE (Reference data for lead origin)
-- ============================================================================

create table if not exists public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists lead_sources_is_active_idx on public.lead_sources(is_active);

-- Seed common sources
insert into public.lead_sources (name, description) values
  ('website_form', 'Submission from HNC website contact form'),
  ('referral', 'Customer referral'),
  ('google_search', 'Google search / organic'),
  ('facebook_ads', 'Facebook/Instagram advertisement'),
  ('google_ads', 'Google Ads campaign'),
  ('yelp', 'Yelp review or search'),
  ('call_inbound', 'Inbound phone call'),
  ('sms_inquiry', 'SMS/text message inquiry'),
  ('email_inquiry', 'Email inquiry'),
  ('event', 'Event/sponsorship')
on conflict (name) do nothing;

-- ============================================================================
-- 2. ENHANCE LEADS TABLE (Add automation & conversion tracking)
-- ============================================================================

alter table public.leads
  add column if not exists assigned_to_id uuid references public.cleaners(id) on delete set null,
  add column if not exists source_id uuid references public.lead_sources(id) on delete set null,
  add column if not exists converted_client_id uuid references public.clients(id) on delete set null,
  add column if not exists next_followup_date date,
  add column if not exists num_contacts integer not null default 0,
  add column if not exists last_contacted_at timestamptz,
  add column if not exists custom_fields jsonb, -- For extensibility
  add column if not exists notes_history jsonb default '[]'::jsonb; -- Audit trail of note changes

-- Add missing indexes on leads
create index if not exists leads_stage_idx on public.leads(stage);
create index if not exists leads_created_at_desc_idx on public.leads(created_at desc);
create index if not exists leads_source_id_idx on public.leads(source_id);
create index if not exists leads_assigned_to_idx on public.leads(assigned_to_id);
create index if not exists leads_converted_client_idx on public.leads(converted_client_id);
create index if not exists leads_email_idx on public.leads(email);
create index if not exists leads_phone_idx on public.leads(phone);

-- ============================================================================
-- 3. LEAD AUTOMATIONS TABLE (Visual automation builder storage)
-- ============================================================================

create table if not exists public.lead_automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  
  -- Trigger configuration
  trigger_type text not null, -- 'form_submission', 'lead_created', 'stage_changed', 'scheduled'
  trigger_config jsonb not null, -- {source_id?: '...', old_stage?: '...', new_stage?: '...', time_of_day?: '09:00'}
  
  -- Actions to execute (array of action objects)
  -- Example: [{type: 'sms', message: '...', delay_minutes: 0}, {type: 'assign_cleaner', cleaner_id: '...'}]
  actions jsonb not null,
  
  -- State
  is_enabled boolean not null default true,
  created_by text, -- Admin who created automation
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lead_automations_is_enabled_idx on public.lead_automations(is_enabled);
create index if not exists lead_automations_trigger_type_idx on public.lead_automations(trigger_type);
create index if not exists lead_automations_created_at_idx on public.lead_automations(created_at desc);

-- ============================================================================
-- 4. LEAD AUTOMATION RUNS (Audit trail / run logs)
-- ============================================================================

create table if not exists public.lead_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.lead_automations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  trigger_data jsonb, -- What triggered this run (e.g., {source_id: '...', stage: 'New'})
  actions_executed jsonb, -- [{action_index: 0, type: 'sms', status: 'success', result: {...}}]
  status text not null default 'pending', -- pending/running/success/failed
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  
  constraint unique_run unique (automation_id, lead_id, started_at)
);

create index if not exists lar_lead_id_idx on public.lead_automation_runs(lead_id);
create index if not exists lar_automation_id_idx on public.lead_automation_runs(automation_id);
create index if not exists lar_status_idx on public.lead_automation_runs(status);
create index if not exists lar_created_at_idx on public.lead_automation_runs(started_at desc);

-- ============================================================================
-- 5. MISSING INDEXES ON CORE TABLES (Performance)
-- ============================================================================

-- appointments: critical filters
create index if not exists appointments_status_idx on public.appointments(status);
create index if not exists appointments_series_id_idx on public.appointments(series_id);
create index if not exists appointments_cleaner_id_idx on public.appointments(cleaner_id);
create index if not exists appointments_date_cleaner_idx on public.appointments(date, cleaner_id);

-- cleaners: activity & assignment
create index if not exists cleaners_status_idx on public.cleaners(status);
create index if not exists cleaners_email_idx on public.cleaners(email);

-- clients: access patterns
create index if not exists clients_status_idx on public.clients(status);

-- call_transcripts: CRM linking (when available)
create index if not exists call_transcripts_phone_idx on public.call_transcripts(phone_number);
create index if not exists call_transcripts_created_idx on public.call_transcripts(created_at desc);

-- pay_periods: cleaner lookups
create index if not exists pay_periods_cleaner_idx on public.pay_periods(cleaner_id);
create index if not exists pay_periods_period_start_idx on public.pay_periods(period_start desc);

-- ============================================================================
-- 6. SETTINGS UPDATE (Lead capture config)
-- ============================================================================

insert into public.settings (key, value)
values 
  ('lead_form_enabled', 'true'::jsonb),
  ('lead_form_url_slug', '"contact"'::jsonb),
  ('lead_default_source_id', '(select id from lead_sources where name = ''website_form'' limit 1)'::text),
  ('lead_auto_assign_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- ============================================================================
-- 7. NOTES
-- ============================================================================
-- 
-- Usage for Lead Automations:
-- 
-- Trigger types:
--   - form_submission: Lead created via web form (config: {source_id: '...'})
--   - lead_created: Any new lead (no specific config needed)
--   - stage_changed: Lead moved to new stage (config: {old_stage: '...', new_stage: '...'})
--   - scheduled: Runs at specific time (config: {time_of_day: 'HH:MM', days: ['MO', 'WE', 'FR']})
--
-- Action types (in actions array):
--   - sms: Send SMS to lead (config: {message: '...', phone_field: 'phone'})
--   - email: Send email (config: {template: 'welcome', to_field: 'email'})
--   - assign_cleaner: Assign lead to cleaner (config: {cleaner_id: '...'})
--   - update_stage: Move lead to stage (config: {new_stage: 'Contacted'})
--   - create_appointment: Create test appointment (config: {date_offset_days: 7, service: 'Regular Cleaning'})
--   - webhook: POST to external URL (config: {url: '...', method: 'POST'})
--   - internal_notification: Notify team (config: {message: '...'})
--
-- All actions can have optional delay_minutes for sequential timing.
--
-- Example automation JSON:
-- {
--   "name": "Welcome new web leads",
--   "trigger_type": "form_submission",
--   "trigger_config": {"source_id": "<website_form_id>"},
--   "actions": [
--     {
--       "type": "sms",
--       "message": "Hi! Thanks for reaching out to Hawaii Natural Clean. We'll follow up within 24 hours.",
--       "delay_minutes": 5
--     },
--     {
--       "type": "internal_notification",
--       "message": "New lead from website: {name} ({phone})",
--       "delay_minutes": 0
--     }
--   ],
--   "is_enabled": true
-- }
-- ============================================================================
