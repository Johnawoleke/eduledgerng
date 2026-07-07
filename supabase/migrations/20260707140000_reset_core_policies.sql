-- =============================================================================
-- RESET CORE POLICIES — production still carried older, differently-named
-- Lovable-era RLS policies that my earlier `drop policy if exists eduledger_*`
-- statements never removed. Because permissive policies are OR'd together, a
-- stray `using(true)` policy kept anon reads of students (plaintext PINs) alive
-- and could re-open bursar write paths.
--
-- Fix: for each sensitive table, DROP EVERY existing policy, then recreate ONLY
-- the canonical set. The frontend only READS these tables (all writes go through
-- service-role edge functions), so no client flow depends on the dropped ones.
-- Idempotent; safe on prod (SQL editor) and staging (db push).
-- =============================================================================

do $$
declare
  t text;
  p record;
begin
  foreach t in array array[
    'students', 'schools', 'school_admins', 'school_requests', 'class_fees', 'profiles'
  ] loop
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- students: reads/adds by school members; edits/deletes by owners only.
create policy eduledger_students_select on public.students
  for select using (public.is_school_member(school_id));
create policy eduledger_students_insert on public.students
  for insert with check (public.is_school_member(school_id));
create policy eduledger_students_update on public.students
  for update using (public.is_school_owner(school_id))
  with check (public.is_school_owner(school_id));
create policy eduledger_students_delete on public.students
  for delete using (public.is_school_owner(school_id));

-- schools: public read (portals show the name; slug lookups); owner-only writes.
create policy eduledger_schools_select on public.schools
  for select using (true);
create policy eduledger_schools_update on public.schools
  for update using (public.is_school_owner(id))
  with check (public.is_school_owner(id));

-- school_admins: a user sees their own memberships; owners see their school's
-- roster and may remove members (never themselves). Inserts/updates only via
-- service-role edge functions.
create policy eduledger_school_admins_select on public.school_admins
  for select using (user_id = auth.uid() or public.is_school_member(school_id));
create policy eduledger_school_admins_delete on public.school_admins
  for delete using (public.is_school_owner(school_id) and user_id <> auth.uid());

-- school_requests: invitee/inviter/owner can read; owner or inviter can cancel.
create policy eduledger_school_requests_select on public.school_requests
  for select using (
    user_id = auth.uid() or requested_by = auth.uid() or public.is_school_owner(school_id)
  );
create policy eduledger_school_requests_delete on public.school_requests
  for delete using (
    requested_by = auth.uid() or public.is_school_owner(school_id)
  );

-- class_fees: students see published fees; members see all; members create only
-- pending fees; owners publish/edit; the DB trigger still locks published rows.
create policy eduledger_class_fees_select on public.class_fees
  for select using (status = 'published' or public.is_school_member(school_id));
create policy eduledger_class_fees_insert on public.class_fees
  for insert with check (public.is_school_member(school_id) and status = 'pending');
create policy eduledger_class_fees_update on public.class_fees
  for update
  using (public.is_school_owner(school_id) or (public.is_school_member(school_id) and status = 'pending'))
  with check (public.is_school_owner(school_id) or (public.is_school_member(school_id) and status = 'pending'));
create policy eduledger_class_fees_delete on public.class_fees
  for delete using (public.is_school_owner(school_id));

-- profiles: a user reads/edits their own; a school OWNER may additionally read
-- the profiles (name/email) of their school's members and of people they have a
-- pending invite out to — this powers the owner-only staff list without exposing
-- everyone's email to the anon key. Inserts happen via service-role functions.
create policy eduledger_profiles_select on public.profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1 from public.school_admins sa_owner
      join public.school_admins sa_member on sa_owner.school_id = sa_member.school_id
      where sa_owner.user_id = auth.uid() and sa_owner.role = 'owner'
        and sa_member.user_id = profiles.id
    )
    or exists (
      select 1 from public.school_requests sr
      where sr.user_id = profiles.id
        and (sr.requested_by = auth.uid() or public.is_school_owner(sr.school_id))
    )
  );
create policy eduledger_profiles_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
