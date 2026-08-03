-- =============================================================================
-- default_pin: hold ONLY an un-redeemed temporary password
--
-- Hashing students.pin (20260803110000) achieved nothing on its own, because
-- student-set-pin was writing the student's CHOSEN password straight into
-- students.default_pin in plaintext:
--
--     .update({ pin: new_pin, default_pin: new_pin, ... })
--
-- so the column shadowed the hash with a live credential. On staging this was
-- true for 16 of 17 students. The application fix is already in
-- (student-set-pin and change-pin now write default_pin = null); this migration
-- remediates the rows already on disk and makes the invariant enforceable.
--
-- The invariant: default_pin is the temporary password the SCHOOL issued and
-- the student has not yet replaced. The moment must_change_pin goes false, it
-- must be null. It is never a password the student chose.
--
-- The column is kept (not dropped) because it is genuinely needed: a CSV upload
-- creates many students at once, each with its own random temporary password,
-- and the owner has to be able to read them back to hand out. The admin roster
-- shows it only for students still awaiting first login.
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remediate: clear every default_pin belonging to a student who has already
--    set their own password. On production these are live credentials in
--    plaintext — treat them as compromised (see the note in CLAUDE.md about
--    forcing a rotation).
-- ---------------------------------------------------------------------------
update public.students
set default_pin = null
where default_pin is not null
  and coalesce(must_change_pin, false) = false;

-- ---------------------------------------------------------------------------
-- 2. Enforce it, so no future write path can reintroduce the leak. This runs
--    BEFORE hash_student_pin's alphabetical sibling only by name, so keep it
--    independent of that trigger: it touches default_pin, never pin.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_default_pin_invariant()
returns trigger
language plpgsql
as $$
begin
  if coalesce(new.must_change_pin, false) = false then
    new.default_pin := null;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_default_pin_invariant on public.students;
create trigger enforce_default_pin_invariant
  before insert or update on public.students
  for each row execute function public.enforce_default_pin_invariant();
