-- =============================================================================
-- RECORD WHICH GATEWAY TOOK EACH PAYMENT
--
-- The platform is moving from Paystack-only to Squad, with Paystack retained so
-- Paystack for Education can be routed back in later for large fees. Once more
-- than one gateway is live, a reference alone is not enough: verify-payment and
-- the webhooks have to know WHICH provider to ask about a given payment, and
-- reconciliation has to know which one settled it.
--
-- Every existing row predates Squad, so they are all Paystack.
--
-- The column is deliberately NOT constrained to a fixed list. A CHECK would have
-- to be migrated every time a provider is added, and the value is written only
-- by service-role edge functions from a typed union — the database is not the
-- right place to enforce it.
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

alter table public.payments
  add column if not exists gateway text;

-- Backfill: everything recorded before this migration went through Paystack.
update public.payments
set gateway = 'paystack'
where gateway is null;

alter table public.payments
  alter column gateway set default 'squad';

-- Reconciliation and the admin payments tab filter by gateway once two are live.
create index if not exists payments_gateway_idx on public.payments (gateway);

comment on column public.payments.gateway is
  'Which payment gateway processed this row: squad | paystack. Written by the '
  'create-payment edge function from selectGateway() in gatewayMoney.ts. '
  'verify-payment reads it to know which provider API to query.';
