-- =============================================================================
-- HASH STUDENT PINs
--
-- `students.pin` was a plaintext column compared with `v_pin = p_pin`. Anyone
-- who ever saw the table — a DB dump, a backup, a support query, or the anon-key
-- read that existed before 20260707120000 — got every student's live password.
--
-- Approach: a BEFORE INSERT/UPDATE trigger hashes `pin` with bcrypt. Doing it in
-- the database (rather than in each writer) means every path is covered at once,
-- including the two that write from the browser with the owner's session
-- (SchoolAdminDashboard's add-student, CSV upload, and reset-password), which
-- cannot hash safely on the client.
--
-- `default_pin` still holds a plaintext value on purpose: it is the one-time
-- temporary password the owner reads off the dashboard to hand to the student.
-- It is now cleared the moment the student sets their own password (see
-- student-set-pin / change-pin), so it never holds a password the student chose.
--
-- Idempotent — re-running will not double-hash (already-bcrypt values are left
-- alone). Run on prod via SQL editor; on staging via db push.
-- =============================================================================

-- pgcrypto lives in `extensions` on projects created by recent Supabase, but in
-- `public` on older ones (this project predates the change). `if not exists` is
-- a no-op when it is already installed anywhere, so rather than schema-qualify
-- crypt()/gen_salt() — which would break on whichever layout we guessed wrong —
-- put both schemas on the search_path and call them unqualified. Every function
-- below carries the same `set search_path`, and this statement covers the
-- top-level backfill.
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

-- A bcrypt digest: $2<variant>$<cost>$<22-char salt><31-char hash>
create or replace function public.is_bcrypt_hash(p_value text)
returns boolean
language sql
immutable
as $$
  select p_value ~ '^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$';
$$;

create or replace function public.hash_student_pin()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.pin is null or new.pin = '' then
    return new;
  end if;

  -- Already hashed (an UPDATE that doesn't touch the pin, or a re-run of the
  -- backfill below) — leave it exactly as it is.
  if public.is_bcrypt_hash(new.pin) then
    return new;
  end if;

  new.pin := crypt(new.pin, gen_salt('bf', 10));
  return new;
end;
$$;

drop trigger if exists hash_student_pin on public.students;
create trigger hash_student_pin
  before insert or update of pin on public.students
  for each row execute function public.hash_student_pin();

-- -----------------------------------------------------------------------------
-- Backfill: hash every plaintext pin already on disk.
--
-- The trigger above is already live, so it re-checks each row and leaves the
-- freshly-computed digest alone — no double-hashing.
--
-- OPERATIONAL NOTE: bcrypt at cost 10 is ~50-80ms per row by design. That is the
-- right cost for a login, but it makes this backfill roughly one minute per
-- thousand students, in a single transaction. Check the row count first
-- (`select count(*) from public.students`); past ~5,000, run it from psql rather
-- than the SQL editor, or batch it by school_id, so it can't hit a statement
-- timeout mid-way.
-- -----------------------------------------------------------------------------
update public.students
set pin = crypt(pin, gen_salt('bf', 10))
where pin is not null
  and pin <> ''
  and not public.is_bcrypt_hash(pin);

-- -----------------------------------------------------------------------------
-- verify_student_pin: constant-time bcrypt comparison instead of `=`.
--
-- Everything else is preserved from 20260707180000 — the archived/inactive
-- exclusion, the 5-strike/15-minute lockout, and the "return no rows" contract
-- that every caller treats as invalid credentials.
--
-- One change beyond hashing: a failed attempt against a student ID that does not
-- exist used to return *before* touching any counter, so ID enumeration was free
-- and unmetered. Callers now additionally go through an IP throttle (see
-- 20260803120000); this function keeps its per-student lockout.
-- -----------------------------------------------------------------------------
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
set search_path = public, extensions
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
  if v_pin is null or v_pin = '' then
    return;
  end if;

  if v_pin = crypt(p_pin, v_pin) then
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
