-- =============================================================================
-- ROLLBACK for 20260706130000_reconcile_live_schema.sql
--
-- Restores the database to its exact pre-migration state. Safe to run any
-- time BEFORE real usage starts; after that, dropping the payments columns
-- would discard recorded payments and deleting seeded sessions would cascade
-- to fees/payments attached to them — so treat this as an early-rollback tool.
--
-- Lives outside supabase/migrations on purpose: `db push` must never apply it.
-- =============================================================================

-- 5. foreign keys (reverse order of the migration)
alter table public.payments      drop constraint if exists payments_school_id_fkey;
alter table public.class_fees    drop constraint if exists class_fees_school_id_fkey;
alter table public.school_admins drop constraint if exists school_admins_school_id_fkey;
alter table public.students      drop constraint if exists students_school_id_fkey;
alter table public.terms         drop constraint if exists terms_school_id_fkey;
alter table public.sessions      drop constraint if exists sessions_school_id_fkey;

-- 4. RLS policies (all names are migration-owned; nothing pre-existing is touched)
drop policy if exists eduledger_school_requests_select on public.school_requests;
drop policy if exists eduledger_payments_select        on public.payments;
drop policy if exists eduledger_class_fees_manage      on public.class_fees;
drop policy if exists eduledger_class_fees_select      on public.class_fees;
drop policy if exists eduledger_terms_manage           on public.terms;
drop policy if exists eduledger_terms_select           on public.terms;
drop policy if exists eduledger_sessions_manage        on public.sessions;
drop policy if exists eduledger_sessions_select        on public.sessions;

-- 3. seeded sessions/terms — removes ONLY periods that have nothing attached
--    (no fees or payments reference them), which is exactly the seeded state.
delete from public.terms t
where not exists (select 1 from public.class_fees cf where cf.term_id = t.id)
  and not exists (select 1 from public.payments p where p.term_id = t.id);
delete from public.sessions s
where not exists (select 1 from public.terms t where t.session_id = s.id)
  and not exists (select 1 from public.class_fees cf where cf.session_id = s.id)
  and not exists (select 1 from public.payments p where p.session_id = s.id);

-- 2. class_fees unique index + restore the deduplicated rows from backup
drop index if exists public.class_fees_school_class_name_period_key;
insert into public.class_fees
  select * from public.class_fees_duplicates_backup b
  where not exists (select 1 from public.class_fees cf where cf.id = b.id);
drop table if exists public.class_fees_duplicates_backup;

-- 1. payments columns and index
drop index if exists public.payments_reference_key;
alter table public.payments alter column date drop default;
alter table public.payments drop column if exists items;
alter table public.payments drop column if exists method;
alter table public.payments drop column if exists reference;
alter table public.payments drop column if exists amount;
