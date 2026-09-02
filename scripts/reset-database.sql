-- =============================================================================
-- RESET THE APPLICATION DATA, READY FOR REAL SCHOOL ONBOARDING
--
-- Empties every application table. Keeps the schema, RLS policies, functions,
-- triggers and migration history — only the ROWS go.
--
-- THIS IS IRREVERSIBLE. Take a backup first (Supabase → Database → Backups →
-- and confirm one exists from today). Nothing in this script can undo it.
--
-- WHY TRUNCATE AND NOT DELETE. Two reasons, both load-bearing:
--
--   1. class_fees carries protect_published_class_fees, a BEFORE DELETE trigger
--      that raises "Published fees are locked for the session and cannot be
--      deleted" — even for the service role. A DELETE-based wipe stops dead
--      there. TRUNCATE does not fire row triggers.
--   2. payments and student_charges reference sessions/terms/class_fees with
--      ON DELETE RESTRICT. Ordered DELETEs have to get the order exactly right
--      or they fail halfway and leave the database half-cleared. TRUNCATE with
--      CASCADE resolves the order itself.
--
-- Everything is one transaction: it all succeeds or nothing changes.
--
-- Tables are looked up before use, so this runs unchanged against a project
-- that never had the legacy ones.
-- =============================================================================

do $$
declare
  wanted text[] := array[
    -- money and its audit trail
    'payment_events', 'payments',
    -- the fee ledger
    'student_charges', 'student_enrolments', 'class_fees', 'fee_items',
    -- students and their credentials
    'students', 'student_sessions', 'student_auth_throttle',
    -- academic periods
    'terms', 'sessions',
    -- schools, their people and their settlement details
    'school_settlement', 'school_admins', 'school_requests', 'schools',
    -- everything else
    'notifications',
    -- a leftover from an old dedupe, may not exist
    'class_fees_duplicates_backup'
  ];
  t text;
  present text[] := '{}';
begin
  foreach t in array wanted loop
    if to_regclass('public.' || t) is not null then
      present := present || t;
    end if;
  end loop;

  raise notice 'Truncating % table(s): %', array_length(present, 1), array_to_string(present, ', ');

  execute 'truncate table public.'
       || array_to_string(present, ', public.')
       || ' restart identity cascade';
end $$;
