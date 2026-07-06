-- Migration 20260323110729 created trigger `on_school_created_create_session`.
-- Migration 20260324154935 replaced the trigger with a new one named `on_school_created`
-- but only dropped the new name, not the old one. Both triggers were left active and both
-- call create_default_session(), which caused duplicate-key errors on school insert
-- (duplicate (school_id, name) in academic_sessions) on any DB created after the later
-- migrations were introduced.
--
-- Drop the orphan explicitly.
drop trigger if exists on_school_created_create_session on public.schools;
