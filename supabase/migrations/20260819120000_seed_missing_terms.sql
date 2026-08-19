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
-- The correct uniqueness is per session.
--
-- It is NOT true that the old rule was strictly stronger. The two cover
-- different columns, and rows with a corrupt school_id slip between them:
-- session 5c3b40fd (school "qwert") holds two "2nd Term" rows, one carrying the
-- real school id and one carrying 88b47ae2-f70f-4f8f-a1ae-6f4b0f13c56a — a
-- near-miss of the real id that belongs to no school at all. Different
-- school_id, so the old constraint allowed both; same session, so the correct
-- one rejects them. Those duplicates are cleaned up below before the index is
-- built.
--
-- Idempotent. Run on prod via the SQL editor; on staging via db push.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Drop the constraint that made per-session terms impossible
-- ---------------------------------------------------------------------------
alter table public.terms drop constraint if exists unique_term_name_per_school;
drop index if exists public.unique_term_name_per_school;

-- ---------------------------------------------------------------------------
-- 2. Clean up duplicate terms before the correct index can be built
--
-- Which row survives matters. Ordering by id alone can nominate the row that
-- fees and payments actually point at, which is then skipped as undeletable —
-- leaving the duplicate in place and the index still impossible to build. So it
-- keeps, in order: whatever money references, then the copy whose school_id
-- matches its session (the non-corrupt one), then anything deterministic.
--
-- A duplicate is deleted ONLY when no fee and no payment points at it. term_id
-- is a restricting foreign key from both, and a term with money attached is not
-- something to remove on a hunch. Anything left is reported rather than forced.
-- ---------------------------------------------------------------------------
with refs as (
  select t.id,
         (exists (select 1 from public.class_fees cf where cf.term_id = t.id)
          or exists (select 1 from public.payments p where p.term_id = t.id)) as referenced
    from public.terms t
),
ranked as (
  select t.id,
         row_number() over (
           partition by t.session_id, t.name
           order by r.referenced desc,                 -- keep whatever money points at
                    (t.school_id = s.school_id) desc,  -- then the non-corrupt copy
                    t.id                               -- then anything, deterministically
         ) as rn
    from public.terms t
    join public.sessions s on s.id = t.session_id
    join refs r on r.id = t.id
),
doomed as (
  select ranked.id
    from ranked
    join refs on refs.id = ranked.id
   where ranked.rn > 1
     and not refs.referenced
)
delete from public.terms t using doomed d where t.id = d.id;

-- Per session, which is what the model has always meant.
create unique index if not exists terms_session_name_key
  on public.terms (session_id, name);

-- ---------------------------------------------------------------------------
-- 3. Seed terms for every session that has none
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
-- 4. Verify
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing integer;
  v_orphan  integer;
  v_terms   integer;
  v_dupes   integer;
begin
  select count(*) into v_dupes from (
    select session_id, name from public.terms
     group by session_id, name having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'S% session/term name pair(s) are still duplicated and have fees or payments attached, so they were not removed automatically. Resolve them by hand before re-running.',
      v_dupes;
  end if;

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
