#!/usr/bin/env node

// Simple migration runner using fetch

const SUPABASE_URL = 'https://hehfecnjmgsthxjxlvpz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const migrationSQL = `-- 004_automation_segments.sql
alter table public.leads
  add column if not exists segment text not null default 'initial_sequence',
  add column if not exists segment_moved_at timestamptz default now(),
  add column if not exists response_count integer not null default 0,
  add column if not exists last_responded_at timestamptz,
  add column if not exists booking_count_6m integer not null default 0,
  add column if not exists first_booking_date date,
  add column if not exists last_booking_date date,
  add column if not exists last_automation_run_at timestamptz,
  add column if not exists blacklist_reason text;

create index if not exists leads_segment_idx on public.leads(segment);
create index if not exists leads_response_count_idx on public.leads(response_count);
create index if not exists leads_last_responded_idx on public.leads(last_responded_at);
create index if not exists leads_booking_count_idx on public.leads(booking_count_6m);

create table if not exists public.lead_automation_state (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  automation_id uuid not null references public.lead_automations(id) on delete cascade,
  status text not null default 'active',
  current_action_index integer not null default 0,
  next_action_at timestamptz,
  actions_completed jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unique_active_automation unique (lead_id, automation_id, status) where status = 'active'
);

create index if not exists las_lead_id_idx on public.lead_automation_state(lead_id);
create index if not exists las_automation_idx on public.lead_automation_state(automation_id);
create index if not exists las_status_idx on public.lead_automation_state(status);
create index if not exists las_next_action_idx on public.lead_automation_state(next_action_at);

create table if not exists public.lead_responses (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  channel text not null,
  content text,
  created_at timestamptz not null default now(),
  received_from text,
  automation_id uuid references public.lead_automations(id) on delete set null
);

create index if not exists lr_lead_id_idx on public.lead_responses(lead_id);
create index if not exists lr_channel_idx on public.lead_responses(channel);
create index if not exists lr_created_idx on public.lead_responses(created_at desc);
create index if not exists lr_automation_idx on public.lead_responses(automation_id);`;

async function runMigration() {
  if (!SUPABASE_KEY) {
    console.log('❌ SUPABASE_SERVICE_ROLE_KEY not set');
    console.log('Run: export SUPABASE_SERVICE_ROLE_KEY="your-key"');
    return false;
  }

  try {
    console.log('🔄 Running database migration...\n');
    
    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ query: migrationSQL })
    });

    console.log('Response status:', response.status);
    
    if (response.ok || response.status === 201) {
      console.log('✅ Migration completed!\n');
      console.log('✅ Added columns: segment, response_count, last_responded_at, etc.');
      console.log('✅ Created tables: lead_automation_state, lead_responses');
      console.log('\nNext step: Seed the automations');
      return true;
    } else {
      const text = await response.text();
      console.log('⚠️ Response:', text.substring(0, 200));
      return false;
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    return false;
  }
}

runMigration().then(success => {
  process.exit(success ? 0 : 1);
});
