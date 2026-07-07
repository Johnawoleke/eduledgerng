-- =============================================================================
-- Archived students must not be able to log in. verify_student_pin previously
-- excluded only status='inactive', so an archived student (status='archived',
-- ADR-010) was hidden from the roster but could still authenticate. Exclude
-- 'archived' too. Signature/return type unchanged, so CREATE OR REPLACE is safe.
-- =============================================================================

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
    and coalesce(s.status, 'active') not in ('inactive', 'archived')
  limit 1;

  if v_id is null then
    return;
  end if;
  if v_locked is not null and v_locked > now() then
    return;
  end if;

  if v_pin = p_pin then
    update public.students
      set failed_login_attempts = 0, locked_until = null
      where students.id = v_id;

    return query
      select s.id, s.student_id, s.name, s.class, s.school_id, s.session, s.term,
             coalesce(s.must_change_pin, false)
      from public.students s
      where s.id = v_id;
  else
    update public.students
      set failed_login_attempts = v_attempts + 1,
          locked_until = case when v_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
      where students.id = v_id;
    return;
  end if;
end;
$$;
