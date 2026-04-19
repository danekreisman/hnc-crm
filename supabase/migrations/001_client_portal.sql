-- Client Portal v1 migration
-- Adds portal auth linkage + new portal-only tables.
-- Does NOT enable RLS on clients/appointments/invoices to avoid breaking the existing CRM (anon key reads).
-- Portal API routes use the service role key and enforce per-user scoping in code.

-- 1) Link clients to Supabase auth users
alter table public.clients
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create index if not exists clients_auth_user_id_idx on public.clients(auth_user_id);
create index if not exists clients_email_lower_idx on public.clients ((lower(email)));
create index if not exists clients_phone_idx on public.clients (phone);

-- 2) Portal access requests (when a sign-in identity doesn't match a known client)
create table if not exists public.client_portal_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  auth_user_id uuid references auth.users(id) on delete cascade,
  email text,
  phone text,
  full_name text,
  message text,
  status text not null default 'pending',
  resolved_at timestamptz,
  resolved_by text,
  linked_client_id uuid references public.clients(id) on delete set null
);

create index if not exists cpr_status_idx on public.client_portal_requests(status);
create index if not exists cpr_created_idx on public.client_portal_requests(created_at desc);

alter table public.client_portal_requests enable row level security;

drop policy if exists "own portal request read" on public.client_portal_requests;
create policy "own portal request read"
  on public.client_portal_requests for select
  using (auth.uid() = auth_user_id);

drop policy if exists "own portal request insert" on public.client_portal_requests;
create policy "own portal request insert"
  on public.client_portal_requests for insert
  with check (auth.uid() = auth_user_id);

-- 3) OTP store for OpenPhone/Quo SMS sign-in
create table if not exists public.portal_phone_otp (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists otp_phone_idx on public.portal_phone_otp(phone);
create index if not exists otp_expires_idx on public.portal_phone_otp(expires_at);

alter table public.portal_phone_otp enable row level security;

-- 4) Notification channel toggle for admin alerts
insert into public.settings (key, value)
values ('portal_notify_channels', '{"email": true, "sms": true}'::jsonb)
on conflict (key) do nothing;
