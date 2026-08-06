-- =============================================================================
-- GUARD EVERY GATEWAY'S SETTLEMENT KEY, NOT JUST PAYSTACK'S
--
-- guard_school_settlement_settings (20260803120000) was written when Paystack
-- was the only gateway, and it names its two keys literally. Adding Squad
-- silently reopened both holes it was built to close:
--
--   1. A bank-details change cleared paystack_subaccount_code but left
--      squad_sub_merchant_id in place, so every later payment kept settling into
--      the school's OLD bank account — exactly the bug the trigger exists to
--      prevent, reintroduced for the gateway that is actually live.
--
--   2. Clients could write squad_sub_merchant_id directly. schools UPDATE is
--      owner-only, so this is not anonymous, but anyone who takes over an owner
--      account could point that school's fee income at a Squad sub-merchant they
--      control. The Paystack keys were blocked; the Squad one was not.
--
-- Both verified against staging before this migration.
--
-- The fix generalises the trigger over a list of protected keys instead of
-- naming them inline. Adding a gateway now means adding its key to that array —
-- and if that is forgotten, the key is simply unprotected rather than silently
-- diverging in behaviour from the others, so keep this list in step with
-- settlementKey() in supabase/functions/_shared/gateways.ts.
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

create or replace function public.guard_school_settlement_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Must mirror settlementKey() in _shared/gateways.ts, plus any cached
  -- bank codes that belong to a provisioned settlement account.
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

  v_bank_changed :=
    new.bank_name is distinct from old.bank_name
    or new.account_number is distinct from old.account_number;

  if auth.uid() is not null then
    -- A client (school owner) write. Never let it author a settlement key:
    -- strip them all, then restore the stored values only if the bank details
    -- are unchanged. If the bank DID change they stay stripped, so the next
    -- payment re-provisions against the new account.
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

drop trigger if exists guard_school_settlement_settings on public.schools;
create trigger guard_school_settlement_settings
  before update on public.schools
  for each row execute function public.guard_school_settlement_settings();

-- ---------------------------------------------------------------------------
-- Persist what we expect to collect, on the payment row itself.
--
-- The underpayment guard in _shared/recordPayment.ts read expected_total_kobo
-- out of the metadata the GATEWAY echoes back. When that echo is missing or
-- shaped differently than expected, `Number(undefined)` is NaN, the guard is
-- skipped entirely, and the pending row is flipped to success crediting the
-- full fees with no amount check at all.
--
-- That is not hypothetical: Squad's verify/webhook response shape is inferred
-- from partial public documentation, so a key we did not anticipate would
-- disable the check on every payment.
--
-- Storing it at checkout means the guard depends on OUR row, not on the
-- provider echoing our metadata back faithfully. Rows created before this
-- column exists are null and keep the previous "trust it" behaviour, which is
-- correct — they are all long settled.
-- ---------------------------------------------------------------------------
alter table public.payments
  add column if not exists expected_total_kobo bigint;

comment on column public.payments.expected_total_kobo is
  'What the gateway was asked to collect, in kobo, written by create-payment. '
  'The underpayment guard prefers this over gateway-supplied metadata so a '
  'missing or unexpected metadata shape cannot disable the check.';
