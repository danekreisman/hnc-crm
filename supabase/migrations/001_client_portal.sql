-- Client Portal migration
-- Run in Supabase SQL Editor (or via supabase CLI).

-- 1. Link clients to Supabase auth users
alter table if exists public.clients
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_clients_auth_user_id on public.clients(auth_user_id);
create index if not exists idx_clients_email_lower on public.clients (lower(email));
create index if not exists idx_clients_phone on public.clients(phone);

-- 2. Portal request inbox (reschedule / cancel / new booking requests from clients)
create table if not exists public.client_portal_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('new_booking','reschedule','cancel','profile_update','message')),
  appointment_id uuid references public.appointments(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','approved','denied','cancelled')),
  admin_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_cpr_status_created on public.client_portal_requests(status, created_at desc);
create index if not exists idx_cpr_client on public.client_portal_requests(client_id);
create index if not exists idx_cpr_auth_user on public.client_portal_requests(auth_user_id);

-- 3. SMS OTP table (for OpenPhone-powered passwordless sign-in)
create table if not exists public.portal_phone_otp (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_otp_phone_active on public.portal_phone_otp(phone, expires_at);

-- 4. Settings row for admin notification channels (email / sms)
insert into public.settings (key, value)
values ('portal_notify_channels', '["email","sms"]'::jsonb)
on conflict (key) do nothing;

-- 5. Row Level Security
alter table public.clients enable row level security;
alter table public.appointments enable row level security;
alter table public.invoices enable row level security;
alter table public.client_portal_requests enable row level security;

-- Clients: a signed-in user can read/update only their own row
drop policy if exists "clients self read" on public.clients;
create policy "clients self read" on public.clients
  for select using (auth_user_id = auth.uid());

drop policy if exists "clients self update" on public.clients;
create policy "clients self update" on public.clients
  for update using (auth_user_id = auth.uid());

-- Appointments: client reads their own appointments
drop policy if exists "appointments client read" on public.appointments;
create policy "appointments client read" on public.appointments
  for select using (
    client_id in (select id from public.clients where auth_user_id = auth.uid())
  );

-- Invoices: client reads their own invoices (by appointment -> client)
drop policy if exists "invoices client read" on public.invoices;
create policy "invoices client read" on public.invoices
  for select using (
    appointment_id in (
      select a.id from public.appointments a
      join public.clients c on c.id = a.client_id
      where c.auth_user_id = auth.uid()
    )
  );

-- Portal requests: client can insert / read their own
drop policy if exists "cpr client insert" on public.client_portal_requests;
create policy "cpr client insert" on public.client_portal_requests
  for insert with check (auth_user_id = auth.uid());

drop policy if exists "cpr client read" on public.client_portal_requests;
create policy "cpr client read" on public.client_portal_requests
  for select using (auth_user_id = auth.uid());

-- Note: the service_role key bypasses RLS, so admin API functions and the CRM
-- (which uses the anon key + authenticated admin flows) are unaffected.
