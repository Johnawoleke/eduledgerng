-- =============================================================================
-- FEE APPROVAL WORKFLOW
--
-- New fees are created as 'pending' and only become visible to students once
-- an owner publishes them. Published fees are immutable for the whole session
-- (enforced by a trigger, so even the service role cannot bypass it).
-- Existing rows default to 'published' so nothing disappears for students.
-- Idempotent; additive except for the policy split noted below.
-- =============================================================================

alter table public.class_fees add column if not exists status text not null default 'published';
alter table public.class_fees add column if not exists created_by uuid;
alter table public.class_fees add column if not exists approved_by uuid;
alter table public.class_fees add column if not exists approved_at timestamptz;

-- -----------------------------------------------------------------------------
-- Published fees are locked: no edits, no deletes, no un-publishing.
-- The only allowed transition is pending -> published (the approval itself).
-- -----------------------------------------------------------------------------
create or replace function public.protect_published_class_fees()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'Published fees are locked for the session and cannot be deleted';
    end if;
    return old;
  end if;

  if old.status = 'published' then
    if new.status is distinct from 'published'
       or new.amount is distinct from old.amount
       or new.name is distinct from old.name
       or new.class_target is distinct from old.class_target
       or new.session_id is distinct from old.session_id
       or new.term_id is distinct from old.term_id
       or new.school_id is distinct from old.school_id then
      raise exception 'Published fees are locked for the session and cannot be changed';
    end if;
  end if;

  if old.status = 'pending' and new.status = 'published' then
    new.approved_at := coalesce(new.approved_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists protect_published_class_fees on public.class_fees;
create trigger protect_published_class_fees
  before update or delete on public.class_fees
  for each row execute function public.protect_published_class_fees();

-- -----------------------------------------------------------------------------
-- Helper: is the current user an OWNER of the school (creator or owner-role
-- member)? Bursars are members but not owners.
-- -----------------------------------------------------------------------------
create or replace function public.is_school_owner(school_id_param uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.schools sc
    where sc.id = school_id_param and sc.owner_id = auth.uid()
  ) or exists (
    select 1 from public.school_admins sa
    where sa.school_id = school_id_param and sa.user_id = auth.uid() and sa.role = 'owner'
  );
$$;

-- -----------------------------------------------------------------------------
-- RLS: split the old blanket policies.
--   read:   everyone sees PUBLISHED fees; school members also see pending ones
--   insert: members may create fees, but only as 'pending'
--   update: owners may do anything the trigger allows (i.e. approve pending /
--           edit pending); bursars may edit their school's fees only while
--           they stay pending
--   delete: owners only (trigger still blocks deleting published rows)
-- -----------------------------------------------------------------------------
drop policy if exists eduledger_class_fees_select on public.class_fees;
create policy eduledger_class_fees_select on public.class_fees
  for select using (status = 'published' or public.is_school_member(school_id));

drop policy if exists eduledger_class_fees_manage on public.class_fees;

drop policy if exists eduledger_class_fees_insert on public.class_fees;
create policy eduledger_class_fees_insert on public.class_fees
  for insert with check (public.is_school_member(school_id) and status = 'pending');

drop policy if exists eduledger_class_fees_update on public.class_fees;
create policy eduledger_class_fees_update on public.class_fees
  for update
  using (
    public.is_school_owner(school_id)
    or (public.is_school_member(school_id) and status = 'pending')
  )
  with check (
    public.is_school_owner(school_id)
    or (public.is_school_member(school_id) and status = 'pending')
  );

drop policy if exists eduledger_class_fees_delete on public.class_fees;
create policy eduledger_class_fees_delete on public.class_fees
  for delete using (public.is_school_owner(school_id));
