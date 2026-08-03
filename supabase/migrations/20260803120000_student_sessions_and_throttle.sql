-- =============================================================================
-- STUDENT SESSIONS, LOGIN THROTTLE, AND SETTLEMENT-ACCOUNT PROTECTION
--
-- Three separate holes, all in the "someone else's money" blast radius:
--
-- 1. The student session WAS the password. schoolContext persisted
--    {student_id, pin} to localStorage forever and every privileged call
--    (refresh, change-pin, pay) re-sent it. One XSS or one shared school
--    computer meant permanent credential compromise, with nothing to revoke.
--    -> Opaque bearer tokens with an expiry, stored hashed, revocable.
--
-- 2. Nothing rate-limited `student-auth`. A failed attempt against a
--    non-existent student ID never touched the per-student lockout, so IDs
--    (format: INITIALS-NNNN) could be enumerated at line speed, and every
--    account still on its issued temporary password fell to a single guess.
--    -> Per-IP throttle, checked before any credential work.
--
-- 3. Changing a school's bank details left settings.paystack_subaccount_code
--    pointing at the OLD account, so every later payment silently settled into
--    the previous bank account.
--    -> A trigger clears the cached subaccount whenever the bank details
--       change, and blocks clients from writing the cache directly.
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

-- See 20260803110000 for why pgcrypto is called unqualified with both schemas
-- on the search_path rather than schema-qualified.
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. student_sessions
--
-- Only the token's SHA-256 digest is stored, so a leak of this table does not
-- yield usable sessions. RLS is enabled with NO policies: the anon and
-- authenticated roles get nothing, and only the service-role edge functions
-- (which bypass RLS) can mint or check a session.
-- -----------------------------------------------------------------------------
create table if not exists public.student_sessions (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.students(id) on delete cascade,
  school_id    uuid not null references public.schools(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_used_at timestamptz
);

create index if not exists student_sessions_student_idx
  on public.student_sessions (student_id);
create index if not exists student_sessions_expiry_idx
  on public.student_sessions (expires_at);

alter table public.student_sessions enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'student_sessions'
  loop
    execute format('drop policy %I on public.student_sessions', p.policyname);
  end loop;
end $$;

-- Resolve a bearer token to its student, sliding `last_used_at` and dropping
-- anything expired. Returns no rows for an unknown/expired token — the same
-- "empty result means denied" contract verify_student_pin uses.
create or replace function public.verify_student_session(p_token text)
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
  v_hash text;
  v_student uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return;
  end if;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  select ss.student_id into v_student
  from public.student_sessions ss
  where ss.token_hash = v_hash and ss.expires_at > now()
  limit 1;

  if v_student is null then
    return;
  end if;

  update public.student_sessions set last_used_at = now() where token_hash = v_hash;

  -- must_change_pin is excluded, not just reported. When an owner resets a
  -- student's password the flag goes back on, and that has to kill any session
  -- the previous holder still has — otherwise a reset issued *because* an
  -- account was compromised would leave the attacker logged in. The student's
  -- next request 401s, which the dashboard turns into a clean re-login.
  return query
    select s.id, s.student_id, s.name, s.class, s.school_id, s.session, s.term,
           coalesce(s.must_change_pin, false)
    from public.students s
    where s.id = v_student
      and coalesce(s.status, 'active') not in ('inactive', 'archived')
      and coalesce(s.must_change_pin, false) = false;
end;
$$;

-- Mint a session for a student. Called only after credentials have already been
-- verified. The caller supplies the raw token; only its digest is persisted.
create or replace function public.create_student_session(
  p_student_id uuid,
  p_school_id uuid,
  p_token text,
  p_ttl_hours integer default 12
)
returns timestamptz
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_expires timestamptz;
begin
  v_expires := now() + make_interval(hours => greatest(1, least(p_ttl_hours, 24)));

  -- Housekeeping lives here rather than in verify_student_session: verification
  -- runs on every dashboard refresh, and a DELETE on that path would put a write
  -- (and lock contention) behind every read. Minting is rare by comparison.
  delete from public.student_sessions where expires_at < now() - interval '7 days';

  insert into public.student_sessions (student_id, school_id, token_hash, expires_at)
  values (
    p_student_id,
    p_school_id,
    encode(digest(p_token, 'sha256'), 'hex'),
    v_expires
  );

  return v_expires;
end;
$$;

-- Invalidate every session for a student (logout-everywhere, and mandatory
-- after a password change so a stolen token dies with the old password).
create or replace function public.revoke_student_sessions(p_student_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.student_sessions where student_id = p_student_id;
$$;

-- -----------------------------------------------------------------------------
-- 2. Per-IP login throttle
-- -----------------------------------------------------------------------------
create table if not exists public.student_auth_throttle (
  ip            text primary key,
  attempts      integer not null default 0,
  window_start  timestamptz not null default now(),
  blocked_until timestamptz
);

alter table public.student_auth_throttle enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'student_auth_throttle'
  loop
    execute format('drop policy %I on public.student_auth_throttle', p.policyname);
  end loop;
end $$;

-- Count one attempt from p_ip. Returns false once the caller has burned through
-- the window's budget, and keeps returning false until the block expires.
-- Atomic: the row is locked for the read-modify-write.
create or replace function public.student_auth_throttle_check(p_ip text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_window_start timestamptz;
  v_blocked timestamptz;
  c_limit  constant integer  := 20;
  c_window constant interval := interval '15 minutes';
  c_block  constant interval := interval '15 minutes';
begin
  if p_ip is null or p_ip = '' then
    return true;
  end if;

  delete from public.student_auth_throttle
  where window_start < now() - interval '1 day'
    and (blocked_until is null or blocked_until < now());

  insert into public.student_auth_throttle (ip, attempts, window_start)
  values (p_ip, 0, now())
  on conflict (ip) do nothing;

  select attempts, window_start, blocked_until
    into v_attempts, v_window_start, v_blocked
  from public.student_auth_throttle
  where ip = p_ip
  for update;

  -- A concurrent caller's housekeeping DELETE can remove the row between the
  -- upsert and this SELECT. Without this guard v_attempts stays null and the
  -- UPDATE below would write null into a NOT NULL column.
  if not found then
    return true;
  end if;

  if v_blocked is not null and v_blocked > now() then
    return false;
  end if;

  -- Window elapsed (or a block just expired) -> start a fresh window.
  if v_window_start < now() - c_window or v_blocked is not null then
    update public.student_auth_throttle
      set attempts = 1, window_start = now(), blocked_until = null
      where ip = p_ip;
    return true;
  end if;

  if v_attempts + 1 > c_limit then
    update public.student_auth_throttle
      set blocked_until = now() + c_block, attempts = 0, window_start = now()
      where ip = p_ip;
    return false;
  end if;

  update public.student_auth_throttle
    set attempts = v_attempts + 1
    where ip = p_ip;
  return true;
end;
$$;

-- A successful login clears the caller's budget so a busy school sharing one
-- NAT address isn't throttled by its own legitimate traffic.
create or replace function public.student_auth_throttle_reset(p_ip text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.student_auth_throttle where ip = p_ip;
$$;

-- -----------------------------------------------------------------------------
-- 3. Settlement-account protection
--
-- create-paystack-payment caches the school's Paystack subaccount in
-- schools.settings and only provisions a new one when that key is absent. So a
-- bank-details change had to invalidate the cache — and nothing did. Enforce it
-- in the database so no future write path can miss it.
--
-- The same trigger stops a client from writing the cache keys directly: only the
-- service role (auth.uid() is null on this table, since RLS already restricts
-- client UPDATEs to the school owner) may set them.
-- -----------------------------------------------------------------------------
create or replace function public.guard_school_settlement_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bank_changed boolean;
begin
  new.settings := coalesce(new.settings, '{}'::jsonb);

  v_bank_changed :=
    new.bank_name is distinct from old.bank_name
    or new.account_number is distinct from old.account_number;

  if auth.uid() is not null then
    -- A client (school owner) write: never let it author the cached subaccount.
    -- Carry the stored values forward unchanged...
    new.settings := new.settings
      - 'paystack_subaccount_code'
      - 'paystack_bank_code';

    if not v_bank_changed then
      if coalesce(old.settings, '{}'::jsonb) ? 'paystack_subaccount_code' then
        new.settings := jsonb_set(
          new.settings,
          '{paystack_subaccount_code}',
          old.settings -> 'paystack_subaccount_code'
        );
      end if;
      if coalesce(old.settings, '{}'::jsonb) ? 'paystack_bank_code' then
        new.settings := jsonb_set(
          new.settings,
          '{paystack_bank_code}',
          old.settings -> 'paystack_bank_code'
        );
      end if;
    end if;
    -- ...and if the bank DID change, they stay stripped, so the next payment
    -- re-provisions a subaccount against the new account number.
    return new;
  end if;

  -- Service-role write. Still invalidate the cache on a bank change, so an
  -- edge function updating bank details can't leave a stale subaccount either.
  if v_bank_changed
     and new.settings -> 'paystack_subaccount_code'
         is not distinct from coalesce(old.settings, '{}'::jsonb) -> 'paystack_subaccount_code' then
    new.settings := new.settings
      - 'paystack_subaccount_code'
      - 'paystack_bank_code';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_school_settlement_settings on public.schools;
create trigger guard_school_settlement_settings
  before update on public.schools
  for each row execute function public.guard_school_settlement_settings();
