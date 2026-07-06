-- =============================================================================
-- RECONCILE LIVE SCHEMA — run this once against the live Supabase project
-- (ifonivphhfplntzshtsb) via Dashboard > SQL Editor, or `supabase db push`.
--
-- Background: the live database was rebuilt by hand when the project moved off
-- the Lovable-managed tenant, and it drifted from both the app code and the
-- older migrations in this folder. This script brings the live schema up to
-- what the code expects. It is idempotent and only ADDS things — it never
-- drops columns, tables, or data, and it does not flip RLS on/off.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. payments: the app (webhook, dashboards, receipts) reads/writes
--    amount / reference / method / items, none of which exist live.
-- -----------------------------------------------------------------------------
alter table public.payments add column if not exists amount numeric not null default 0;
alter table public.payments add column if not exists reference text;
alter table public.payments add column if not exists method text;
alter table public.payments add column if not exists items text[] not null default '{}';
alter table public.payments alter column date set default now();

-- Backfill from the legacy column, then keep both in sync going forward is not
-- needed — the code only writes `amount` from now on.
update public.payments set amount = amount_paid where amount = 0 and amount_paid is not null;

-- zendfi-webhook relies on reference for idempotency
create unique index if not exists payments_reference_key
  on public.payments (reference) where reference is not null;

-- -----------------------------------------------------------------------------
-- 2. class_fees: the Add/Update Fee dialog upserts with
--    onConflict "school_id,class_target,name,session_id,term_id" — that fails
--    unless a matching unique constraint exists.
-- -----------------------------------------------------------------------------
create unique index if not exists class_fees_school_class_name_period_key
  on public.class_fees (school_id, class_target, name, session_id, term_id);

-- -----------------------------------------------------------------------------
-- 3. Seed sessions + terms for schools that have none (schools registered
--    before register-school started seeding them have empty selectors).
-- -----------------------------------------------------------------------------
do $$
declare
  s record;
  new_session_id uuid;
  y int := extract(year from now())::int;
begin
  for s in
    select sc.id from public.schools sc
    where not exists (select 1 from public.sessions se where se.school_id = sc.id)
  loop
    insert into public.sessions (school_id, name, start_year, end_year, is_current)
    values (s.id, y || '/' || (y + 1), y, y + 1, true)
    returning id into new_session_id;

    insert into public.terms (session_id, school_id, name, term_number, is_current) values
      (new_session_id, s.id, 'Term 1', 1, true),
      (new_session_id, s.id, 'Term 2', 2, false),
      (new_session_id, s.id, 'Term 3', 3, false);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 4. RLS policies. Policies are permissive (OR'd), so adding these can only
--    grant the access the app needs — it cannot revoke anything.
--    "School member" = the school owner or anyone in school_admins.
-- -----------------------------------------------------------------------------

-- sessions: everyone can read (student dashboard uses the anon key);
-- school members manage their own school's sessions.
drop policy if exists eduledger_sessions_select on public.sessions;
create policy eduledger_sessions_select on public.sessions
  for select using (true);

drop policy if exists eduledger_sessions_manage on public.sessions;
create policy eduledger_sessions_manage on public.sessions
  for all using (
    exists (select 1 from public.schools sc where sc.id = sessions.school_id and sc.owner_id = auth.uid())
    or exists (select 1 from public.school_admins sa where sa.school_id = sessions.school_id and sa.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.schools sc where sc.id = sessions.school_id and sc.owner_id = auth.uid())
    or exists (select 1 from public.school_admins sa where sa.school_id = sessions.school_id and sa.user_id = auth.uid())
  );

-- terms: same as sessions
drop policy if exists eduledger_terms_select on public.terms;
create policy eduledger_terms_select on public.terms
  for select using (true);

drop policy if exists eduledger_terms_manage on public.terms;
create policy eduledger_terms_manage on public.terms
  for all using (
    exists (select 1 from public.schools sc where sc.id = terms.school_id and sc.owner_id = auth.uid())
    or exists (select 1 from public.school_admins sa where sa.school_id = terms.school_id and sa.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.schools sc where sc.id = terms.school_id and sc.owner_id = auth.uid())
    or exists (select 1 from public.school_admins sa where sa.school_id = terms.school_id and sa.user_id = auth.uid())
  );

-- class_fees: readable by everyone (fees are shown pre-login), managed by members
drop policy if exists eduledger_class_fees_select on public.class_fees;
create policy eduledger_class_fees_select on public.class_fees
  for select using (true);

drop policy if exists eduledger_class_fees_manage on public.class_fees;
create policy eduledger_class_fees_manage on public.class_fees
  for all using (
    exists (select 1 from public.schools sc where sc.id = class_fees.school_id and sc.owner_id = auth.uid())
    or exists (select 1 from public.school_admins sa where sa.school_id = class_fees.school_id and sa.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.schools sc where sc.id = class_fees.school_id and sc.owner_id = auth.uid())
    or exists (select 1 from public.school_admins sa where sa.school_id = class_fees.school_id and sa.user_id = auth.uid())
  );

-- payments: readable (student dashboard reads with anon key; writes happen via
-- service-role edge functions which bypass RLS).
drop policy if exists eduledger_payments_select on public.payments;
create policy eduledger_payments_select on public.payments
  for select using (true);

-- school_requests: invitees must see invitations addressed to them, and the
-- admins who sent them can track them. Writes happen via service-role functions.
drop policy if exists eduledger_school_requests_select on public.school_requests;
create policy eduledger_school_requests_select on public.school_requests
  for select using (user_id = auth.uid() or requested_by = auth.uid());

-- -----------------------------------------------------------------------------
-- 5. Missing foreign keys (each wrapped so a pre-existing constraint or dirty
--    data cannot abort the rest of the script).
-- -----------------------------------------------------------------------------
do $$
begin
  begin
    alter table public.sessions add constraint sessions_school_id_fkey
      foreign key (school_id) references public.schools(id) on delete cascade;
  exception when duplicate_object or others then null;
  end;
  begin
    alter table public.terms add constraint terms_school_id_fkey
      foreign key (school_id) references public.schools(id) on delete cascade;
  exception when duplicate_object or others then null;
  end;
  begin
    alter table public.students add constraint students_school_id_fkey
      foreign key (school_id) references public.schools(id) on delete cascade;
  exception when duplicate_object or others then null;
  end;
  begin
    alter table public.school_admins add constraint school_admins_school_id_fkey
      foreign key (school_id) references public.schools(id) on delete cascade;
  exception when duplicate_object or others then null;
  end;
  begin
    alter table public.class_fees add constraint class_fees_school_id_fkey
      foreign key (school_id) references public.schools(id) on delete cascade;
  exception when duplicate_object or others then null;
  end;
  begin
    alter table public.payments add constraint payments_school_id_fkey
      foreign key (school_id) references public.schools(id) on delete cascade;
  exception when duplicate_object or others then null;
  end;
end $$;
