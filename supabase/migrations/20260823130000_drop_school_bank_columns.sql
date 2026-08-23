-- =============================================================================
-- CLOSE THE EXPOSURE: drop the settlement columns from schools
--
-- Second half of 20260823120000. That migration created school_settlement and
-- copied the data across; this one removes the originals, which is what
-- actually stops the anon key from reading them.
--
-- DO NOT RUN THIS UNTIL the edge functions and the frontend that read
-- school_settlement are deployed. Anything still selecting schools.bank_name
-- errors the moment these columns go. Order:
--   20260823120000 -> edge functions -> frontend -> this migration
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

-- Safety net: anything that arrived between the backfill and this drop.
insert into public.school_settlement
  (school_id, bank_name, account_number, account_name, settings)
select
  s.id, s.bank_name, s.account_number, s.account_name,
  jsonb_strip_nulls(jsonb_build_object(
    'paystack_subaccount_code', coalesce(s.settings, '{}'::jsonb) -> 'paystack_subaccount_code',
    'paystack_bank_code',       coalesce(s.settings, '{}'::jsonb) -> 'paystack_bank_code',
    'squad_sub_merchant_id',    coalesce(s.settings, '{}'::jsonb) -> 'squad_sub_merchant_id',
    'squad_bank_code',          coalesce(s.settings, '{}'::jsonb) -> 'squad_bank_code'
  ))
from public.schools s
where (s.bank_name is not null or s.account_number is not null or s.account_name is not null)
on conflict (school_id) do nothing;

-- The guard on schools has nothing left to guard once the bank columns are
-- gone; guard_settlement_row replaces it on the new table.
drop trigger if exists guard_school_settlement_settings on public.schools;
drop function if exists public.guard_school_settlement_settings();

alter table public.schools drop column if exists bank_name;
alter table public.schools drop column if exists account_number;
alter table public.schools drop column if exists account_name;

-- schools.settings stays — final_class lives there and is not sensitive — but
-- the settlement keys must not, or the anon key can still read which account a
-- school settles into.
update public.schools
   set settings = coalesce(settings, '{}'::jsonb)
                    - 'paystack_subaccount_code'
                    - 'paystack_bank_code'
                    - 'squad_sub_merchant_id'
                    - 'squad_bank_code'
 where coalesce(settings, '{}'::jsonb) ?| array[
         'paystack_subaccount_code', 'paystack_bank_code',
         'squad_sub_merchant_id', 'squad_bank_code'
       ];

comment on column public.schools.settings is
  'School configuration that is safe to read before login (final_class, and '
  'the like). schools SELECT is using(true) for the pre-login portal, so '
  'NOTHING sensitive belongs here — settlement details live in '
  'school_settlement.';
