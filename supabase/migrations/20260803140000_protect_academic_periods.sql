-- =============================================================================
-- PROTECT ACADEMIC PERIODS — stop a period deletion from orphaning money
--
-- Two gaps that combine badly:
--
-- 1. `sessions` and `terms` each had a single `FOR ALL` policy granting any
--    school MEMBER full rights — so a bursar could DELETE a session, not just
--    read it. Nothing in the app has ever updated or deleted these rows (the
--    only writes are the auto-seed inserts in useAcademicPeriods), so the
--    permission was pure unused blast radius.
--
-- 2. `payments.session_id`, `payments.term_id`, `class_fees.session_id` and
--    `class_fees.term_id` had NO foreign keys at all. The only one that existed
--    was terms.session_id -> sessions ON DELETE CASCADE.
--
-- Together: deleting a session cascaded its terms away and left every payment
-- and fee for that period pointing at a UUID that no longer exists. Those
-- payments disappear from the period-filtered dashboards — the money is real and
-- still in the bank, but the record of what it was for is gone, and nothing
-- reports an error.
--
-- After this migration a period that has any fee or payment attached CANNOT be
-- deleted by anyone (ON DELETE RESTRICT), and only an owner may modify or remove
-- an empty one.
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Clean up any already-dangling references, so the constraints below can be
--    created. Staging had none; PRODUCTION DID — which is direct evidence that a
--    session really was deleted on production at some point, orphaning the fees
--    and payments attached to it. These rows are already broken; nulling makes
--    them "no period assigned", which surfaces honestly in the UI instead of
--    silently filtering to nothing.
--
--    The class_fees updates have to step around protect_published_class_fees
--    (20260707090000), which rejects ANY change to session_id/term_id on a
--    published row. That rule is right for normal operation — it stops a school
--    retroactively moving a fee students are already paying — but here the
--    period it points at no longer exists, so there is nothing to protect and
--    the trigger would otherwise block the repair outright:
--
--      ERROR: P0001: Published fees are locked for the session and cannot be changed
--
--    The trigger is disabled only for these two statements and re-enabled
--    immediately. ALTER TABLE is transactional, so if anything below fails the
--    whole block — including the disable — rolls back together.
-- ---------------------------------------------------------------------------
do $$
declare
  v_payments int := 0;
  v_fees int := 0;
  v_students int := 0;
  v_has_trigger boolean;
begin
  update public.payments p set session_id = null
  where p.session_id is not null
    and not exists (select 1 from public.sessions s where s.id = p.session_id);
  get diagnostics v_payments = row_count;

  update public.payments p set term_id = null
  where p.term_id is not null
    and not exists (select 1 from public.terms t where t.id = p.term_id);

  select exists (
    select 1 from pg_trigger
    where tgname = 'protect_published_class_fees'
      and tgrelid = 'public.class_fees'::regclass
      and not tgisinternal
  ) into v_has_trigger;

  if v_has_trigger then
    execute 'alter table public.class_fees disable trigger protect_published_class_fees';
  end if;

  update public.class_fees c set session_id = null
  where c.session_id is not null
    and not exists (select 1 from public.sessions s where s.id = c.session_id);
  get diagnostics v_fees = row_count;

  update public.class_fees c set term_id = null
  where c.term_id is not null
    and not exists (select 1 from public.terms t where t.id = c.term_id);

  if v_has_trigger then
    execute 'alter table public.class_fees enable trigger protect_published_class_fees';
  end if;

  update public.students st set session_id = null
  where st.session_id is not null
    and not exists (select 1 from public.sessions s where s.id = st.session_id);
  get diagnostics v_students = row_count;

  if v_payments > 0 or v_fees > 0 or v_students > 0 then
    raise notice 'Orphaned period references cleared: % payments, % fees, % students',
      v_payments, v_fees, v_students;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Foreign keys. RESTRICT, not CASCADE: a period with money attached must not
--    be removable at all, by anyone, including the service role.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    alter table public.payments add constraint payments_session_id_fkey
      foreign key (session_id) references public.sessions(id) on delete restrict;
  exception when duplicate_object then null;
  end;
  begin
    alter table public.payments add constraint payments_term_id_fkey
      foreign key (term_id) references public.terms(id) on delete restrict;
  exception when duplicate_object then null;
  end;
  begin
    alter table public.class_fees add constraint class_fees_session_id_fkey
      foreign key (session_id) references public.sessions(id) on delete restrict;
  exception when duplicate_object then null;
  end;
  begin
    alter table public.class_fees add constraint class_fees_term_id_fkey
      foreign key (term_id) references public.terms(id) on delete restrict;
  exception when duplicate_object then null;
  end;
  -- A student's session is a label, not money: let it null out rather than
  -- blocking the delete of an otherwise-empty period.
  begin
    alter table public.students add constraint students_session_id_fkey
      foreign key (session_id) references public.sessions(id) on delete set null;
  exception when duplicate_object then null;
  end;
end $$;

-- Supporting indexes — RESTRICT checks scan the referencing side on every
-- period delete, and the dashboards filter by these columns constantly.
create index if not exists payments_session_idx on public.payments (session_id);
create index if not exists payments_term_idx on public.payments (term_id);
create index if not exists class_fees_session_idx on public.class_fees (session_id);
create index if not exists class_fees_term_idx on public.class_fees (term_id);

-- ---------------------------------------------------------------------------
-- 3. Split the blanket FOR ALL policies.
--
--    SELECT stays public: the student dashboard reads periods with the anon key
--    (students hold no JWT) and period names are not sensitive.
--    INSERT stays member-level: useAcademicPeriods auto-seeds a school's first
--    session/terms on load, and that runs as whoever is signed in.
--    UPDATE/DELETE become owner-only — no app code path uses either.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['sessions', 'terms'] loop
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy eduledger_sessions_select on public.sessions
  for select using (true);
create policy eduledger_sessions_insert on public.sessions
  for insert with check (public.is_school_member(school_id));
create policy eduledger_sessions_update on public.sessions
  for update using (public.is_school_owner(school_id))
  with check (public.is_school_owner(school_id));
create policy eduledger_sessions_delete on public.sessions
  for delete using (public.is_school_owner(school_id));

create policy eduledger_terms_select on public.terms
  for select using (true);
create policy eduledger_terms_insert on public.terms
  for insert with check (public.is_school_member(school_id));
create policy eduledger_terms_update on public.terms
  for update using (public.is_school_owner(school_id))
  with check (public.is_school_owner(school_id));
create policy eduledger_terms_delete on public.terms
  for delete using (public.is_school_owner(school_id));
