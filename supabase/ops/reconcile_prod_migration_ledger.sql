-- =============================================================================
-- ONE-TIME: reconcile the Supabase CLI migration ledger on PRODUCTION.
--
-- Production was hand-built, so `supabase_migrations.schema_migrations` (the
-- ledger the CLI uses to decide what to run) has no entries for the migrations
-- we applied by pasting SQL. This marks all already-applied migrations as
-- "applied" WITHOUT re-running them, so a future `supabase db push` runs only
-- genuinely new migrations instead of trying (and failing) to re-create the
-- baseline schema.
--
-- Run ONCE in the prod SQL editor. It only writes to the ledger table — it does
-- NOT touch any application schema or data. Idempotent (on conflict do nothing).
-- This file lives outside supabase/migrations/ on purpose so it never runs
-- itself as a migration.
-- =============================================================================

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);

insert into supabase_migrations.schema_migrations (version, name, statements) values
  ('20260706120000', 'baseline_live_schema', '{}'),
  ('20260706130000', 'reconcile_live_schema', '{}'),
  ('20260707090000', 'fee_approval_workflow', '{}'),
  ('20260707100000', 'fix_verify_student_pin_lockout', '{}'),
  ('20260707120000', 'harden_bursar_rls', '{}'),
  ('20260707140000', 'reset_core_policies', '{}')
on conflict (version) do nothing;

-- Show the result (you should see these 6 versions, plus any older ones already
-- tracked).
select version, name from supabase_migrations.schema_migrations order by version;
