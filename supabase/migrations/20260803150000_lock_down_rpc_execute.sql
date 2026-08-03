-- =============================================================================
-- LOCK DOWN RPC EXECUTE — the auth functions were callable straight from the
-- browser, which made every other control in the student auth system optional
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and PostgREST
-- publishes everything in the `public` schema as an RPC endpoint. So each of
-- these SECURITY DEFINER functions — which run as their owner and are meant to
-- be reachable only from a service-role edge function — was one anon-key POST
-- to /rest/v1/rpc/<name> away from anybody on the internet.
--
-- What that actually allowed, all without any credential:
--
--   create_student_session   -> mint a valid session token for ANY student id.
--                               Total account takeover, no password involved.
--                               (Introduced 20260803120000.)
--   verify_student_pin       -> an unlimited password-guessing oracle that
--                               completely bypasses the per-IP throttle in
--                               student-auth; only the 5-strike per-student
--                               lockout still applied. PRE-EXISTING — this
--                               function has been anon-callable since the
--                               baseline schema.
--   student_auth_throttle_reset -> clear the throttle at will, which is what
--                               made the guessing oracle unlimited.
--   revoke_student_sessions  -> force-logout any student on demand.
--   verify_student_session   -> confirm whether a token is live, and read the
--                               student row it belongs to.
--
-- Fix: revoke EXECUTE from PUBLIC/anon/authenticated on everything that is not
-- deliberately client-facing, and grant it explicitly to service_role only.
--
-- is_school_member / is_school_owner are the exception and MUST stay executable
-- by anon and authenticated: they are called inside RLS policy expressions,
-- which are evaluated as the querying role. They take a school id and return a
-- boolean about the CALLER's own membership, so they leak nothing.
--
-- Trigger functions (hash_student_pin, protect_published_class_fees,
-- guard_school_settlement_settings, enforce_default_pin_invariant,
-- handle_new_user) are invoked by the trigger machinery as the table owner and
-- never need a client-facing grant.
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

do $$
declare
  fn text;
  sig text;
begin
  foreach fn in array array[
    -- student auth internals: service-role edge functions only
    'verify_student_pin',
    'verify_student_session',
    'create_student_session',
    'revoke_student_sessions',
    'student_auth_throttle_check',
    'student_auth_throttle_reset',
    -- trigger functions: invoked by the trigger, never called directly
    'hash_student_pin',
    'protect_published_class_fees',
    'guard_school_settlement_settings',
    'enforce_default_pin_invariant',
    'handle_new_user',
    -- internal helper
    'is_bcrypt_hash'
  ] loop
    -- Revoke on every overload, by identity, so a stale signature can't survive.
    for sig in
      select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = fn
    loop
      execute format('revoke all on function %s from public', sig);
      execute format('revoke all on function %s from anon', sig);
      execute format('revoke all on function %s from authenticated', sig);
      execute format('grant execute on function %s to service_role', sig);
    end loop;
  end loop;
end $$;

-- is_school_member / is_school_owner are used INSIDE RLS policies, which are
-- evaluated as the querying role — revoking these would deny every policy that
-- references them and lock the whole app out of its own data. Grant explicitly
-- so the intent is recorded rather than merely inherited from the default.
do $$
declare sig text;
begin
  for sig in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('is_school_member', 'is_school_owner')
  loop
    execute format('grant execute on function %s to anon, authenticated, service_role', sig);
  end loop;
end $$;

-- Stop the same hole reappearing: new functions created in `public` from now on
-- get no automatic EXECUTE for the browser-facing roles. Anything genuinely
-- client-callable must grant itself explicitly.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;

-- PostgREST caches the schema, including which RPCs it will expose.
notify pgrst, 'reload schema';
