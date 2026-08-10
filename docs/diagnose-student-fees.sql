-- =============================================================================
-- DIAGNOSE: "students can't see their fees"
--
-- Paste the whole file into the Supabase SQL editor for the affected project.
-- Replace 'demo' on the next line with the school's slug.
--
-- A student sees a fee only when ALL of these hold:
--   1. the fee's status is 'published'      (pending fees are invisible)
--   2. the fee's class_target is exactly the student's class, or 'ALL'
--   3. the fee's session_id + term_id match the period selected in the UI
--      (which defaults to the session/term flagged is_current)
--   4. the student's status is not 'archived' / 'inactive'
--
-- Each section below checks one of those.
-- =============================================================================

\set slug 'demo'

-- ---------------------------------------------------------------------------
-- A. THE MOST COMMON CAUSE: fees created but never published.
--    Bursars can only create fees as 'pending'. Only an OWNER can publish them,
--    from the admin dashboard's Fees tab. Students never see pending fees.
-- ---------------------------------------------------------------------------
select 'A. fees by status' as check, status, count(*) as fees
from public.class_fees
where school_id = (select id from public.schools where slug = 'demo')
group by status;

-- ---------------------------------------------------------------------------
-- B. Which period is the UI showing, and where do the fees actually live?
--    The dashboard defaults to the session/term marked is_current. If the fees
--    were created against a different term, the student sees an empty list.
-- ---------------------------------------------------------------------------
select 'B. current period' as check, s.name as session, t.name as term
from public.sessions s
join public.terms t on t.session_id = s.id
where s.school_id = (select id from public.schools where slug = 'demo')
  and s.is_current and t.is_current;

select 'B. fees per period' as check,
       coalesce(s.name, '(no session)') as session,
       coalesce(t.name, '(no term)') as term,
       c.status, count(*) as fees
from public.class_fees c
left join public.sessions s on s.id = c.session_id
left join public.terms t on t.id = c.term_id
where c.school_id = (select id from public.schools where slug = 'demo')
group by 1,2,3,4
order by 2,3;

-- ---------------------------------------------------------------------------
-- C. Class-name mismatch. The match is EXACT and case-sensitive:
--    a fee for 'JSS 2' will never apply to a student in 'JSS2'.
-- ---------------------------------------------------------------------------
select 'C. student classes' as check, class, count(*) as students
from public.students
where school_id = (select id from public.schools where slug = 'demo')
  and coalesce(status,'active') = 'active'
group by class order by class;

select 'C. fee class_targets' as check, class_target, status, count(*) as fees
from public.class_fees
where school_id = (select id from public.schools where slug = 'demo')
group by class_target, status order by class_target;

-- ---------------------------------------------------------------------------
-- D. THE ANSWER: per active student, how many PUBLISHED fees currently apply,
--    in the period the dashboard defaults to. A 0 here is what the student sees.
-- ---------------------------------------------------------------------------
select 'D. fees visible per student' as check,
       st.student_id, st.name, st.class,
       count(cf.id) as fees_they_can_see
from public.students st
left join public.class_fees cf
       on cf.school_id = st.school_id
      and cf.status = 'published'
      and cf.class_target in (st.class, 'ALL')
      and cf.session_id = (select id from public.sessions
                           where school_id = st.school_id and is_current limit 1)
      and cf.term_id = (select id from public.terms
                        where school_id = st.school_id and is_current limit 1)
where st.school_id = (select id from public.schools where slug = 'demo')
  and coalesce(st.status,'active') = 'active'
group by st.student_id, st.name, st.class
order by fees_they_can_see, st.class, st.student_id;

-- ---------------------------------------------------------------------------
-- E. Students with a missing or blank class — these match no fee at all and
--    show as "Unassigned" in the UI.
-- ---------------------------------------------------------------------------
select 'E. students with no class' as check, student_id, name, class, status
from public.students
where school_id = (select id from public.schools where slug = 'demo')
  and (class is null or btrim(class) = '');
