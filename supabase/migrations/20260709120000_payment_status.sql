-- =============================================================================
-- Payment lifecycle status.
--
-- Payments are now recorded at creation time (status 'pending'), then flipped to
-- 'success' or 'failed' once Paystack reports the outcome (webhook + redirect
-- verify). Only 'success' rows count toward balances and collections; 'pending'
-- and 'failed' rows are kept for visibility (a parent's failed attempt shows up
-- in the admin's payments list instead of vanishing).
--
-- Existing rows are all real, settled payments -> backfill them to 'success'.
-- The column defaults to 'success' so offline/manual inserts (Cash, Bank
-- Transfer) that omit it are still counted, exactly as before.
-- =============================================================================

alter table public.payments
  add column if not exists status text not null default 'success';

update public.payments set status = 'success' where status is null;

-- amount_paid is a legacy NOT NULL column on prod that the payment functions
-- don't populate; default it to 0 so an insert that omits it can't fail. The
-- functions set it explicitly (= amount on success, 0 on pending/failed).
alter table public.payments alter column amount_paid set default 0;

create index if not exists idx_payments_status on public.payments (status);
