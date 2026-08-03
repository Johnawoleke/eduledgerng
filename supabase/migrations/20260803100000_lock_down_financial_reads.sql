-- =============================================================================
-- LOCK DOWN FINANCIAL READS
--
-- `payments` and `payment_events` were both created with `for select using
-- (true)` (baseline 20260706120000 + reconcile 20260706130000) and no later
-- migration narrowed them. Because the anon key is public by design, that made
-- EVERY school's payment history — and every raw Paystack webhook body, which
-- carries card BIN/last4/expiry, the payer's email and their IP — readable by
-- anyone on the internet. payment_events was additionally published over
-- Realtime, so it could be streamed live.
--
-- After this migration:
--   payments        -> readable only by members of the owning school
--   payment_events  -> no client access at all (service-role only, and off
--                      Realtime). Nothing in the app reads it any more.
--   fee_items       -> readable only by members of the owning school
--
-- Students are unaffected: they never read these tables directly. Their
-- balances and history come from the `student-auth` edge function, which uses
-- the service role and bypasses RLS.
--
-- As in 20260707140000, every existing policy on these tables is dropped first
-- — permissive policies are OR'd together, so one stray Lovable-era
-- `using(true)` would silently keep the hole open.
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['payments', 'payment_events', 'fee_items'] loop
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.fee_items enable row level security;

-- payments: school members only. Writes stay service-role-only (no INSERT or
-- UPDATE policy) so a client can never fabricate or alter a payment row.
create policy eduledger_payments_select on public.payments
  for select using (public.is_school_member(school_id));

-- fee_items: legacy table, same scoping.
create policy eduledger_fee_items_select on public.fee_items
  for select using (public.is_school_member(school_id));

-- payment_events: deliberately NO policy. RLS is enabled, so with no policy the
-- anon and authenticated roles get nothing; the service role (webhooks) still
-- writes and reads it because it bypasses RLS. It is a raw-payload audit log and
-- has no business being reachable from a browser.

-- Take it off the Realtime publication too — publication membership is checked
-- before RLS for the initial snapshot on some versions, and nothing subscribes
-- to it any more (the dead PaymentEvents component was removed).
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'payment_events'
  ) then
    alter publication supabase_realtime drop table public.payment_events;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Retention: the stored webhook payloads already on disk still contain card and
-- IP data we never needed. Redact the sensitive branches in place; going forward
-- paystack-webhook strips them before insert.
-- -----------------------------------------------------------------------------
update public.payment_events
set payload = payload #- '{data,authorization}'
                      #- '{data,customer}'
                      #- '{data,ip_address}'
                      #- '{data,log}'
                      #- '{payment,customer}'
where payload is not null
  and (payload #> '{data,authorization}' is not null
       or payload #> '{data,customer}' is not null
       or payload #> '{data,ip_address}' is not null
       or payload #> '{data,log}' is not null
       or payload #> '{payment,customer}' is not null);
