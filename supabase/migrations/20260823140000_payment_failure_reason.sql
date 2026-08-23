-- =============================================================================
-- SAY WHY A PAYMENT FAILED
--
-- A payer who transfers the wrong amount to a Paystack checkout account has the
-- transaction rejected and refunded by Paystack, automatically, within 24 hours
-- (https://support.paystack.com/en/articles/2128642). That is the right outcome
-- and we never mark such a fee paid.
--
-- But we told the payer nothing. The attempt sat as 'pending' forever, their
-- balance did not move, and no screen explained why. Someone who has just sent
-- money and can see no trace of it will send it again.
--
-- A reason on the row, so the student dashboard can say what happened and what
-- to do about it. It has to be per-row rather than one generic line for every
-- failure: "Paystack is refunding you" is true for a rejected transfer and
-- actively wrong for a declined card, where no money ever moved.
--
-- Additive and nullable. Nothing reads it until the frontend deploys, so this
-- is safe to run ahead of the functions.
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

alter table public.payments
  add column if not exists failure_reason text;

comment on column public.payments.failure_reason is
  'Why an attempt did not complete, in words a parent can act on. Written by '
  'the webhook and verify paths. Null for successful and pending attempts.';
