-- =============================================================================
-- PRODUCTION SCHEMA AUDIT
-- Read-only. Run in the SQL editor and paste the results back.
--
-- Tables and columns are already confirmed identical to the repo. What this
-- covers is what PostgREST cannot expose: constraints, foreign keys, indexes
-- and RLS policies — where every divergence found so far has actually lived.
-- =============================================================================

-- 1. CONSTRAINTS on public tables (unique / check / exclusion / pk / fk)
select conrelid::regclass::text as table_name,
       conname                 as constraint_name,
       case contype when 'p' then 'primary key'
                    when 'u' then 'unique'
                    when 'f' then 'foreign key'
                    when 'c' then 'check'
                    else contype::text end as kind,
       pg_get_constraintdef(oid) as definition
  from pg_constraint
 where connamespace = 'public'::regnamespace
 order by table_name, kind, constraint_name;

-- 2. INDEXES
select tablename, indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
 order by tablename, indexname;

-- 3. RLS: is it enabled, and how many policies per table
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       count(p.polname) as policies
  from pg_class c
  left join pg_policy p on p.polrelid = c.oid
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
 group by c.relname, c.relrowsecurity
 order by c.relname;

-- 4. The policies themselves
select tablename, policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
 order by tablename, policyname;

-- 5. TRIGGERS
select c.relname as table_name, t.tgname as trigger_name,
       pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
 order by table_name, trigger_name;
