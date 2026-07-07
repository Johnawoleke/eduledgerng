-- =============================================================================
-- HARDEN RLS — close the bursar-workflow gaps where the UI hid a button but the
-- database still allowed the action via a direct API call.
--
-- Before: students SELECT/UPDATE were using(true) (anyone with the anon key
-- could read every student incl. plaintext pin, and reset any PIN); students
-- DELETE and schools UPDATE allowed any school member (so a bursar could delete
-- students and change the settlement bank account). After: reads/writes are
-- scoped to the right role, matching what the UI already implies.
--
-- Student self-service PIN paths (first-login reset, change-pin) now go through
-- service-role edge functions, so students no longer need any anon write.
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

-- profiles: flag to force a freshly-created bursar to rotate the owner-set
-- temporary password on first login.
alter table public.profiles add column if not exists must_change_password boolean not null default false;

-- ---------------------------------------------------------------------------
-- students: SELECT + INSERT = school member; UPDATE + DELETE = owner only.
-- (Add/upload students is a bursar task; reset-PIN and delete are owner tasks,
--  exactly as the dashboard buttons are gated.)
-- ---------------------------------------------------------------------------
drop policy if exists eduledger_students_select on public.students;
create policy eduledger_students_select on public.students
  for select using (public.is_school_member(school_id));

drop policy if exists eduledger_students_insert on public.students;
create policy eduledger_students_insert on public.students
  for insert with check (public.is_school_member(school_id));

drop policy if exists eduledger_students_update on public.students;
create policy eduledger_students_update on public.students
  for update using (public.is_school_owner(school_id))
  with check (public.is_school_owner(school_id));

drop policy if exists eduledger_students_delete on public.students;
create policy eduledger_students_delete on public.students
  for delete using (public.is_school_owner(school_id));

-- ---------------------------------------------------------------------------
-- schools: reads stay public (portals show the school name pre-login), but
-- UPDATE (bank/settlement details, name, etc.) is owner-only. Bursars must not
-- be able to change where student money settles.
-- ---------------------------------------------------------------------------
drop policy if exists eduledger_schools_update on public.schools;
create policy eduledger_schools_update on public.schools
  for update using (public.is_school_owner(id))
  with check (public.is_school_owner(id));

-- ---------------------------------------------------------------------------
-- school_admins: owners may remove members of their own school (off-boarding).
-- Inserts/updates still happen only via service-role edge functions
-- (add-bursar / handle-school-request), so no INSERT/UPDATE policy is added —
-- a member still cannot escalate their own role.
-- ---------------------------------------------------------------------------
drop policy if exists eduledger_school_admins_delete on public.school_admins;
create policy eduledger_school_admins_delete on public.school_admins
  for delete using (
    public.is_school_owner(school_id) and user_id <> auth.uid()
  );

-- ---------------------------------------------------------------------------
-- school_requests: an owner can see and cancel pending invitations for their
-- school (staff management), in addition to the invitee seeing their own.
-- ---------------------------------------------------------------------------
drop policy if exists eduledger_school_requests_select on public.school_requests;
create policy eduledger_school_requests_select on public.school_requests
  for select using (
    user_id = auth.uid() or requested_by = auth.uid() or public.is_school_owner(school_id)
  );

drop policy if exists eduledger_school_requests_delete on public.school_requests;
create policy eduledger_school_requests_delete on public.school_requests
  for delete using (
    requested_by = auth.uid() or public.is_school_owner(school_id)
  );
