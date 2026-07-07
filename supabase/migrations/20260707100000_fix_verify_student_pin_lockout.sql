-- =============================================================================
-- FIX: verify_student_pin references students.locked_until, which does not
-- exist on the (production) students table — so EVERY student login 500s with
-- 'record "v_student" has no field "locked_until"'.
--
-- This restores login by (a) adding the lockout columns the function expects
-- and (b) replacing verify_student_pin with a single canonical, self-consistent
-- definition that implements PIN-lockout using those columns. Idempotent; safe
-- to run on prod (via SQL editor) and staging (via db push).
-- =============================================================================

alter table public.students add column if not exists failed_login_attempts integer not null default 0;
alter table public.students add column if not exists locked_until timestamptz;

-- Drop every existing overload by name (we can't CREATE OR REPLACE across a
-- changed return type, and the prod signature is unknown).
do $$
declare r record;
begin
  for r in
    select oid::regprocedure as sig
    from pg_proc
    where proname = 'verify_student_pin' and pronamespace = 'public'::regnamespace
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create function public.verify_student_pin(
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
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_pin text;
  v_locked timestamptz;
  v_attempts integer;
begin
  select s.id, s.pin, s.locked_until, coalesce(s.failed_login_attempts, 0)
    into v_id, v_pin, v_locked, v_attempts
  from public.students s
  where s.school_id = p_school_id
    and upper(s.student_id) = upper(p_student_id)
    and coalesce(s.status, 'active') <> 'inactive'
  limit 1;

  -- No such student, or currently locked out → return no rows (caller treats
  -- an empty result as "invalid credentials").
  if v_id is null then
    return;
  end if;
  if v_locked is not null and v_locked > now() then
    return;
  end if;

  if v_pin = p_pin then
    -- Success: clear the failed-attempt counters and return the student.
    update public.students
      set failed_login_attempts = 0, locked_until = null
      where students.id = v_id;

    return query
      select s.id, s.student_id, s.name, s.class, s.school_id, s.session, s.term,
             coalesce(s.must_change_pin, false)
      from public.students s
      where s.id = v_id;
  else
    -- Failure: count it and lock for 15 minutes after 5 consecutive failures.
    update public.students
      set failed_login_attempts = v_attempts + 1,
          locked_until = case when v_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
      where students.id = v_id;
    return;
  end if;
end;
$$;
