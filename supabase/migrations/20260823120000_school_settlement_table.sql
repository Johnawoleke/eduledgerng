-- =============================================================================
-- MOVE SETTLEMENT DETAILS OUT OF THE ANON-READABLE schools TABLE
--
-- schools SELECT is `using(true)` and has to stay that way: the portal shows a
-- school's name and slug before anyone logs in, and the student dashboard reads
-- schools with the anon key because students hold no JWT. The comment on that
-- policy has always said only low-sensitivity naming data may live there.
--
-- It did not. bank_name, account_number and account_name sat in the same row,
-- so every school's bank account was readable by anyone holding the public anon
-- key, with no login at all:
--
--   GET /rest/v1/schools?select=name,bank_name,account_number,account_name
--
-- Verified against PRODUCTION on 2026-08-23: 32 schools, every one of them
-- returned with full bank details. settings came back too, which exposed the
-- cached paystack_subaccount_code — the id of the account a school's fee income
-- settles into.
--
-- RLS is row-level, so the columns cannot be hidden while the row stays public.
-- The fix is to move them to their own table with a member-scoped policy, the
-- same shape payments has: members SELECT, and the cached settlement id stays
-- unwritable by any client.
--
-- This migration only CREATES and BACKFILLS. The old columns are dropped by
-- 20260823130000, which must not run until the functions and the frontend
-- reading this table are deployed. Order is load-bearing:
--   this migration -> edge functions -> frontend -> the drop migration
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

create table if not exists public.school_settlement (
  school_id      uuid primary key references public.schools(id) on delete cascade,
  bank_name      text,
  account_number text,
  account_name   text,
  -- Cached settlement account ids, per gateway. Keyed exactly as
  -- settlementKey() in _shared/gateways.ts names them, so adding a gateway
  -- needs no migration.
  settings       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.school_settlement is
  'Where a school''s fee income settles: its bank account and the cached '
  'gateway settlement account id. Separate from schools because schools is '
  'anon-readable for the pre-login portal and this must never be.';

-- ---------------------------------------------------------------------------
-- Backfill. Only the settlement keys move across; everything else in
-- schools.settings (final_class, and anything added later) stays put, because
-- it is school configuration rather than banking.
-- ---------------------------------------------------------------------------
insert into public.school_settlement
  (school_id, bank_name, account_number, account_name, settings)
select
  s.id,
  s.bank_name,
  s.account_number,
  s.account_name,
  jsonb_strip_nulls(jsonb_build_object(
    'paystack_subaccount_code', coalesce(s.settings, '{}'::jsonb) -> 'paystack_subaccount_code',
    'paystack_bank_code',       coalesce(s.settings, '{}'::jsonb) -> 'paystack_bank_code',
    'squad_sub_merchant_id',    coalesce(s.settings, '{}'::jsonb) -> 'squad_sub_merchant_id',
    'squad_bank_code',          coalesce(s.settings, '{}'::jsonb) -> 'squad_bank_code'
  ))
from public.schools s
where s.bank_name is not null
   or s.account_number is not null
   or s.account_name is not null
   or coalesce(s.settings, '{}'::jsonb) ?| array[
        'paystack_subaccount_code', 'paystack_bank_code',
        'squad_sub_merchant_id', 'squad_bank_code'
      ]
on conflict (school_id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS. Mirrors payments: members read, owners maintain the bank details, and
-- NOTHING may be deleted from a browser.
-- ---------------------------------------------------------------------------
alter table public.school_settlement enable row level security;

drop policy if exists eduledger_school_settlement_select on public.school_settlement;
create policy eduledger_school_settlement_select on public.school_settlement
  for select using (public.is_school_member(school_id));

drop policy if exists eduledger_school_settlement_insert on public.school_settlement;
create policy eduledger_school_settlement_insert on public.school_settlement
  for insert with check (public.is_school_owner(school_id));

drop policy if exists eduledger_school_settlement_update on public.school_settlement;
create policy eduledger_school_settlement_update on public.school_settlement
  for update using (public.is_school_owner(school_id))
           with check (public.is_school_owner(school_id));

-- No delete policy, deliberately: removing the row would orphan a school's
-- settlement account rather than change it.

-- ---------------------------------------------------------------------------
-- The same guard the schools table carried, moved with the data.
--
-- Two jobs, both load-bearing:
--   1. A client may never AUTHOR a settlement key. schools UPDATE was
--      owner-only and that was still not enough — anyone taking over an owner
--      account could point a school's fee income at an account they control.
--   2. Changing the bank details INVALIDATES the cached settlement account.
--      create-payment only provisions when the key is absent, so without this
--      every later payment keeps settling into the school's OLD bank account.
-- ---------------------------------------------------------------------------
create or replace function public.guard_settlement_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Must mirror settlementKey() in _shared/gateways.ts.
  c_protected constant text[] := array[
    'paystack_subaccount_code',
    'paystack_bank_code',
    'squad_sub_merchant_id',
    'squad_bank_code'
  ];
  v_bank_changed boolean;
  k text;
begin
  new.settings := coalesce(new.settings, '{}'::jsonb);
  new.updated_at := now();

  if tg_op = 'INSERT' then
    -- A client creating the row must not arrive with a settlement id already
    -- in it; that is the same forgery the update path blocks.
    if auth.uid() is not null then
      foreach k in array c_protected loop
        new.settings := new.settings - k;
      end loop;
    end if;
    return new;
  end if;

  v_bank_changed :=
    new.bank_name is distinct from old.bank_name
    or new.account_number is distinct from old.account_number;

  if auth.uid() is not null then
    -- Client write: strip every settlement key, then restore the stored value
    -- only if the bank details are unchanged. If the bank DID change they stay
    -- stripped, so the next payment re-provisions against the new account.
    foreach k in array c_protected loop
      new.settings := new.settings - k;
      if not v_bank_changed and coalesce(old.settings, '{}'::jsonb) ? k then
        new.settings := jsonb_set(new.settings, array[k], old.settings -> k);
      end if;
    end loop;
    return new;
  end if;

  -- Service-role write. Still invalidate on a bank change, so an edge function
  -- updating bank details cannot leave a stale settlement account behind. A key
  -- this write is explicitly setting is left alone — that is provisioning.
  if v_bank_changed then
    foreach k in array c_protected loop
      if new.settings -> k is not distinct from coalesce(old.settings, '{}'::jsonb) -> k then
        new.settings := new.settings - k;
      end if;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_settlement_row on public.school_settlement;
create trigger guard_settlement_row
  before insert or update on public.school_settlement
  for each row execute function public.guard_settlement_row();

-- Default privileges in public revoke EXECUTE from public/anon/authenticated
-- (migration 20260803150000), so say explicitly who may call this. It is only
-- ever reached through the trigger; service_role needs the grant because it
-- bypasses RLS, not GRANTs.
revoke all on function public.guard_settlement_row() from public, anon, authenticated;
grant execute on function public.guard_settlement_row() to service_role;
