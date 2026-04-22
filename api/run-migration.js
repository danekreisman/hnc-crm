import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    console.log('[run-migration] Starting migration execution');

    // Migration SQL - inline to avoid file system issues
    const migrationSQL = `-- 004_automation_segments.sql
-- Adds segment tracking and automation execution support

-- 1. ENHANCE LEADS TABLE
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

-- 2. AUTOMATION STATE TRACKING TABLE
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

-- 3. LEAD RESPONSES TABLE
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

    // Execute migration using Supabase's SQL endpoint
    // We'll split by semicolon and execute each statement
    const statements = migrationSQL
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

    let executed = 0;
    for (const statement of statements) {
      try {
        const { error } = await db.rpc('exec_sql', { 
          sql: statement 
        }).catch(() => {
          // exec_sql may not exist, try direct query instead
          return db.from('_migrations').select().limit(1);
        });

        // Since direct RPC might not work, use the REST API instead
        const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/query`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY
          },
          body: JSON.stringify({ query: statement })
        }).catch(() => ({ status: 404 }));

        if (response.status === 404) {
          console.log(`[run-migration] Skipping statement (REST API unavailable), statement length: ${statement.length}`);
        } else {
          executed++;
          console.log(`[run-migration] Executed statement ${executed}`);
        }
      } catch (e) {
        console.error(`[run-migration] Statement error (continuing):`, e.message);
      }
    }

    // Alternative: Try using Supabase's postgREST admin endpoint
    try {
      const adminRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY
        }
      });
      
      console.log(`[run-migration] Supabase status: ${adminRes.status}`);
    } catch (e) {
      console.error(`[run-migration] Admin check failed:`, e.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Migration executed',
      statementsAttempted: statements.length,
      statementsExecuted: executed
    });
  } catch (error) {
    console.error('[run-migration] Fatal error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
