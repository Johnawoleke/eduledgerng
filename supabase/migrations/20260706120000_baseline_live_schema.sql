-- =============================================================================
-- BASELINE — replica of the LIVE production schema (ifonivphhfplntzshtsb),
-- verified column-by-column via the REST API on 2026-07-06.
--
-- Purpose: bring a FRESH project (e.g. eduledgerng-staging) to the same state
-- as production. The reconcile migration (20260706130000) then applies on top,
-- exactly as it will on production.
--
-- PRODUCTION ALREADY HAS ALL OF THIS — never run it there. If you ever point
-- `db push` at production, first mark it applied:
--   supabase migration repair --status applied 20260706120000
-- =============================================================================

-- ----------------------------------------------------------------------------
-- profiles (id = auth user id) + auto-create on signup
-- ----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(),
  email text,
  avatar_url text
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- schools — one row per school/branch, each with its own settlement account
-- ----------------------------------------------------------------------------
create table public.schools (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  slug text unique,
  address text,
  phone text,
  email text,
  school_code text,
  bank_name text,
  account_number text,
  account_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  logo_url text,
  status text default 'active',
  settings jsonb not null default '{}'::jsonb
);

-- ----------------------------------------------------------------------------
-- school_admins — membership + role (owner | bursar)
-- ----------------------------------------------------------------------------
create table public.school_admins (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  role text not null default 'bursar',
  unique (school_id, user_id)
);

-- ----------------------------------------------------------------------------
-- school_requests — bursar invitations (writes via service-role functions)
-- ----------------------------------------------------------------------------
create table public.school_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  user_id uuid not null,
  requested_by uuid not null,
  role text not null default 'bursar',
  status text not null default 'pending',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- students — PIN-based login, no Supabase auth
-- ----------------------------------------------------------------------------
create table public.students (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  session_id uuid,
  full_name text,
  class text not null,
  status text default 'active',
  term_id uuid,
  default_pin text,
  student_id text not null,
  surname text,
  first_name text,
  parent_email text,
  must_change_pin boolean default true,
  name text not null,
  pin text not null,
  term text,
  session text,
  is_first_login boolean default true,
  unique (school_id, student_id)
);

-- ----------------------------------------------------------------------------
-- sessions + terms — academic periods per school
-- ----------------------------------------------------------------------------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  name text not null,
  is_current boolean default false,
  start_year integer,
  end_year integer,
  created_at timestamptz not null default now()
);

create table public.terms (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  school_id uuid not null references public.schools (id) on delete cascade,
  name text not null,
  is_current boolean default false,
  term_number integer
);

-- ----------------------------------------------------------------------------
-- class_fees — fee definitions per class + period
-- ----------------------------------------------------------------------------
create table public.class_fees (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  class_target text not null,
  name text not null,
  amount numeric not null,
  session_id uuid,
  term_id uuid,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- fee_items — legacy per-student fee instances (kept for parity)
-- ----------------------------------------------------------------------------
create table public.fee_items (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  school_id uuid not null references public.schools (id) on delete cascade,
  name text not null,
  amount numeric not null,
  paid numeric not null default 0,
  status text not null default 'unpaid',
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- payments — as they exist LIVE today; the reconcile migration adds
-- amount/reference/method/items on top of this.
-- ----------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  student_id uuid not null references public.students (id) on delete cascade,
  date timestamptz not null default now(),
  session_id uuid,
  term_id uuid,
  created_at timestamptz not null default now(),
  amount_paid numeric
);

-- ----------------------------------------------------------------------------
-- payment_events — webhook audit log (also used by realtime UI)
-- ----------------------------------------------------------------------------
create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  event_type text,
  payment_id text,
  status text,
  amount_usd numeric,
  payload jsonb,
  created_at timestamptz not null default now()
);

do $$
begin
  alter publication supabase_realtime add table public.payment_events;
exception when others then null;
end $$;

-- ----------------------------------------------------------------------------
-- RPC functions used by edge functions and RLS
-- ----------------------------------------------------------------------------
create or replace function public.is_school_member(school_id_param uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.schools sc
    where sc.id = school_id_param and sc.owner_id = auth.uid()
  ) or exists (
    select 1 from public.school_admins sa
    where sa.school_id = school_id_param and sa.user_id = auth.uid()
  );
$$;

create or replace function public.verify_student_pin(
  p_school_id uuid,
  p_student_id text,
  p_pin text
)
returns table (
  id uuid,
  student_id text,
  name text,
  class text,
  school_id uuid,
  session text,
  term text,
  must_change_pin boolean
)
language sql security definer set search_path = public
as $$
  select s.id, s.student_id, s.name, s.class, s.school_id, s.session, s.term,
         coalesce(s.must_change_pin, false)
  from public.students s
  where s.school_id = p_school_id
    and upper(s.student_id) = upper(p_student_id)
    and s.pin = p_pin
    and coalesce(s.status, 'active') <> 'inactive';
$$;

-- ----------------------------------------------------------------------------
-- RLS. Policies below mirror the app's current access patterns (including the
-- known debt: students are anon-readable/updatable because the portal's
-- reset-password page writes directly from the browser).
-- The reconcile migration adds the sessions/terms/class_fees/payments/
-- school_requests policies.
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.schools enable row level security;
alter table public.school_admins enable row level security;
alter table public.school_requests enable row level security;
alter table public.students enable row level security;
alter table public.sessions enable row level security;
alter table public.terms enable row level security;
alter table public.class_fees enable row level security;
alter table public.fee_items enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;

create policy eduledger_profiles_own on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy eduledger_schools_select on public.schools
  for select using (true);
create policy eduledger_schools_update on public.schools
  for update using (owner_id = auth.uid() or public.is_school_member(id))
  with check (owner_id = auth.uid() or public.is_school_member(id));

create policy eduledger_school_admins_select on public.school_admins
  for select using (user_id = auth.uid() or public.is_school_member(school_id));

create policy eduledger_students_select on public.students
  for select using (true);
create policy eduledger_students_update on public.students
  for update using (true) with check (true);
create policy eduledger_students_insert on public.students
  for insert with check (public.is_school_member(school_id));
create policy eduledger_students_delete on public.students
  for delete using (public.is_school_member(school_id));

create policy eduledger_fee_items_select on public.fee_items
  for select using (true);

create policy eduledger_payment_events_select on public.payment_events
  for select using (true);
