-- =============================================================================
-- TERM NAMES ARE UNIQUE PER SESSION, NOT PER SCHOOL — AND SEED THE MISSING ONES
--
-- Production carries a constraint that does not exist in this repo or on
-- staging, hand-added during the move off the Lovable tenant:
--
--     unique_term_name_per_school  UNIQUE (name, school_id)
--
-- It says a school may have exactly ONE "Term 1" ever. But a term belongs to a
-- session, and every session has a Term 1 — so from a school's second session
-- onward, its terms could not be created at all. That is not a nuisance
-- constraint; it is the CAUSE of the 21 sessions on production that have no
-- terms, and a session with no terms can never hold a fee (class_fees.term_id),
-- so a school promoted into one cannot bill for that entire year.
--
-- The correct uniqueness is per session. Nothing is lost by the swap: the old
-- rule was strictly stronger, so no existing row can violate the new one.
--
-- Idempotent. Run on prod via the SQL editor; on staging via db push.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Replace the constraint
-- ---------------------------------------------------------------------------
alter table public.terms drop constraint if exists unique_term_name_per_school;
drop index if exists public.unique_term_name_per_school;

-- Per session, which is what the model has always meant.
create unique index if not exists terms_session_name_key
  on public.terms (session_id, name);

-- ---------------------------------------------------------------------------
-- 2. Seed terms for every session that has none
--
-- Sessions belonging to a school_id with no schools row are skipped: terms
-- carries a foreign key to schools, so those rows cannot be created, and those
-- sessions are already unreachable (no school means no portal and no login).
-- They are counted in the notice rather than dropped silently.
-- ---------------------------------------------------------------------------
insert into public.terms (session_id, school_id, name, term_number, is_current)
select s.id, s.school_id, t.name, t.term_number, t.term_number = 1
  from public.sessions s
  join public.schools sc on sc.id = s.school_id
  cross join (values ('Term 1', 1), ('Term 2', 2), ('Term 3', 3)) as t(name, term_number)
 where not exists (select 1 from public.terms x where x.session_id = s.id);

-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing integer;
  v_orphan  integer;
  v_terms   integer;
begin
  select count(*) into v_missing
    from public.sessions s
    join public.schools sc on sc.id = s.school_id
   where not exists (select 1 from public.terms x where x.session_id = s.id);

  select count(*) into v_orphan
    from public.sessions s
   where not exists (select 1 from public.schools sc where sc.id = s.school_id);

  select count(*) into v_terms from public.terms;

  if v_missing > 0 then
    raise exception
      'Still % real session(s) without terms after seeding. Migration aborted.', v_missing;
  end if;

  raise notice 'Every session of a real school now has terms. % terms in total.', v_terms;
  if v_orphan > 0 then
    raise notice
      'NOTE: % session(s) belong to a school_id with no schools row and were skipped. They are already unreachable.',
      v_orphan;
  end if;
end;
$$;
