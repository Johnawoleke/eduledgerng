-- Payment notifications
--
-- An in-app notification feed, one row per notable event (currently only
-- "a student paid a fee"). Rows are written ONLY by the service role from the
-- paystack-webhook / verify-paystack-payment edge functions; school admins
-- (owner + bursars) read them and mark them read. Delivery to the dashboard is
-- via Supabase Realtime (table added to the publication below).
--
-- Idempotency: webhook and verify can both flip a payment to success in a race,
-- so both call notify(). The partial unique index on `reference` guarantees the
-- notification (and therefore the email + the realtime event) fires exactly
-- once per payment.

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references public.schools(id) on delete cascade,
  type       text not null default 'payment',
  title      text not null,
  body       text,
  reference  text,               -- payments.reference for payment notifications
  amount     numeric,            -- base fee amount, in NGN, for display
  metadata   jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

-- One notification per payment reference (belt-and-suspenders against the
-- webhook/verify race — see notify.ts).
create unique index if not exists notifications_payment_reference_uidx
  on public.notifications (reference)
  where type = 'payment' and reference is not null;

create index if not exists notifications_school_created_idx
  on public.notifications (school_id, created_at desc);

alter table public.notifications enable row level security;

-- Read: any admin (owner or bursar) of the school. Reuses the same helper the
-- rest of the schema uses so "owner + bursars" stays consistent.
drop policy if exists eduledger_notifications_select on public.notifications;
create policy eduledger_notifications_select on public.notifications
  for select using (public.is_school_member(school_id));

-- Update: admins may mark their school's notifications read. (No insert/delete
-- policy — writes come from the service role, which bypasses RLS.)
drop policy if exists eduledger_notifications_update on public.notifications;
create policy eduledger_notifications_update on public.notifications
  for update using (public.is_school_member(school_id))
  with check (public.is_school_member(school_id));

-- Deliver inserts to subscribed dashboards over Realtime.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
