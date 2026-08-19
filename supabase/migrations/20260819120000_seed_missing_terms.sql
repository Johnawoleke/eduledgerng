-- =============================================================================
-- SEED TERMS FOR SESSIONS THAT HAVE NONE
--
-- A fee is keyed to a term (class_fees.term_id), so a session with no terms can
-- never hold a fee. A school promoted into one would be unable to bill for that
-- entire year, and nothing in the UI would explain why.
--
-- 21 of 52 sessions on production were in this state. They were created before
-- session creation and term creation were made one operation
-- (src/lib/academicSessions.ts), by paths that inserted the session alone:
-- useAcademicPeriods only ever seeded terms for a school's FIRST session, and
-- the rollover's "create the year I am promoting into" originally did not seed
-- them at all.
--
-- Seeds the same three terms every other session has, with Term 1 current, and
-- touches only sessions that have none. Idempotent.
--
-- Run on prod via the SQL editor; on staging via db push.
-- =============================================================================

insert into public.terms (session_id, school_id, name, term_number, is_current)
select s.id, s.school_id, t.name, t.term_number, t.term_number = 1
  from public.sessions s
  cross join (values ('Term 1', 1), ('Term 2', 2), ('Term 3', 3)) as t(name, term_number)
 where not exists (
   select 1 from public.terms x where x.session_id = s.id
 );

do $$
declare
  v_missing integer;
  v_terms   integer;
begin
  select count(*) into v_missing
    from public.sessions s
   where not exists (select 1 from public.terms x where x.session_id = s.id);

  select count(*) into v_terms from public.terms;

  if v_missing > 0 then
    raise exception
      'Still % session(s) without terms after seeding. Migration aborted.', v_missing;
  end if;

  raise notice 'Every session now has terms. % terms in total.', v_terms;
end;
$$;
