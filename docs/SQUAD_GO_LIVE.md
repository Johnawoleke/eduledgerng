# Going live on Squad — production runbook

Production is `ifonivphhfplntzshtsb` ("Johnawoleke's Project").

> ## ⚠️ Production payments are DOWN as of 2026-08-10
>
> The deployed frontend calls `create-payment` and `verify-payment`. Neither
> exists on production — both 404. A parent clicking "Pay Fees Online" gets an
> error. **Step 3 below is what fixes it.**

> ## ⚠️ Never put `SQUAD_SECRET_KEY` in `.env.local`
>
> That file feeds Vite. Anything in it prefixed `VITE_` is compiled into the
> JavaScript bundle every visitor downloads, and the whole file is for local dev
> only — edge functions never read it. The key belongs in Supabase edge function
> secrets and nowhere else. Do not paste it into a chat, a commit, or a ticket.

---

## Step 1 — Set the Squad secret (you must do this)

```sh
supabase secrets set SQUAD_SECRET_KEY=sk_xxxxx --project-ref ifonivphhfplntzshtsb
```

Or Dashboard → Project Settings → Edge Functions → Secrets.

If you were issued a sandbox key and want to point at Squad's sandbox host
first, also set `SQUAD_ENV=sandbox`. Leave it unset for live.

Confirm it landed (values are shown hashed, which is expected):

```sh
supabase secrets list --project-ref ifonivphhfplntzshtsb
```

`PAYSTACK_SECRET_KEY` must stay set even though Paystack is unrouted —
`resolveBankCode()` uses Paystack's `/bank` list to turn a school's bank name
into the code Squad needs.

---

## Step 2 — Apply two migrations

Dashboard → SQL Editor, in this order:

| File | What it does |
|---|---|
| `20260806100000_payments_gateway_column.sql` | adds `payments.gateway`, backfills every existing row to `paystack` |
| `20260806110000_guard_all_settlement_keys.sql` | extends the settlement-key guard to Squad, adds `payments.expected_total_kobo` |

Both are additive and safe to run while the old flow is live.

Verify:

```sql
select
  (select count(*) from public.payments where gateway is null)          as ungated_rows,       -- expect 0
  (select count(*) from information_schema.columns
     where table_name='payments' and column_name='expected_total_kobo') as has_expected_col;   -- expect 1
```

---

## Step 3 — Deploy the three functions (this ends the outage)

```sh
supabase functions deploy create-payment verify-payment squad-webhook \
  --project-ref ifonivphhfplntzshtsb
```

Confirm `create-payment` no longer 404s:

```sh
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "https://ifonivphhfplntzshtsb.supabase.co/functions/v1/create-payment" \
  -H "apikey: <prod anon key>" -H "Content-Type: application/json" -d '{}'
```

**400 is the healthy answer** — it means the function is running and rejecting
an empty body. 404 means it is still missing.

---

## Step 4 — Register the webhook with Squad

In the Squad dashboard, set the webhook URL to:

```
https://ifonivphhfplntzshtsb.supabase.co/functions/v1/squad-webhook
```

Without this, payments still complete but only settle when the payer is
redirected back to the dashboard. Anyone who closes the tab mid-payment would
never be credited until they revisit.

---

## Step 5 — THE TEST THAT MATTERS: one small real payment

**Do this before any parent is told to pay.**

The one thing I could not verify from Squad's public docs is how a transaction
is routed to a sub-merchant. `create-payment` sends `sub_merchant_id` on the
initiate call, which is the obvious reading of their API, **but it is an
inference**. If it is wrong, the money settles into the PLATFORM account instead
of the school's, and nothing in the code would notice or complain.

So make the first payment one you can afford to have go to the wrong place:

1. Pick or create a school whose bank account **you** control.
2. Add a student to it, give them a fee of about **₦100**.
3. Pay it for real, end to end.
4. Then check three things:

```sql
-- (a) did it record, against the right gateway, for the right amount?
select reference, gateway, status, amount, expected_total_kobo, method, date
from public.payments order by date desc limit 5;

-- (b) did the webhook arrive and verify? (a signature failure writes nothing)
select event_type, status, created_at
from public.payment_events order by created_at desc limit 10;

-- (c) was a settlement account actually provisioned for the school?
select slug, settings->>'squad_sub_merchant_id' as squad_account
from public.schools where slug = '<your test school>';
```

5. **Then check the Squad dashboard and confirm which account the money settled
   into.** This is the whole point of the exercise. If it landed in the platform
   account rather than the school's, stop — the routing field is wrong and every
   subsequent payment would do the same.

---

## Step 6 — Clean up, once step 5 passes

```sh
supabase functions delete create-paystack-payment --project-ref ifonivphhfplntzshtsb
supabase functions delete verify-paystack-payment --project-ref ifonivphhfplntzshtsb
```

Keep `paystack-webhook`: it stays registered for the historic Paystack rows and
will be needed again if Paystack for Education is routed back in.

---

## Verified against docs.squadco.com on 2026-08-10

These were inferences when the integration was written and are now confirmed:

- **Verify** — `GET /transaction/verify/{transaction_ref}`, returning
  `data.transaction_amount`, `data.transaction_ref`, `data.transaction_status`
  (capitalised: `Success` / `Failed` / `Abandoned` / `Pending`). Matches the
  adapter exactly.
- **Verify carries NO metadata.** Only the webhook's `Body.meta` does. This is
  why the underpayment guard reads `expected_total_kobo` off our own payments
  row — on the verify path there is nothing echoed back to compare against.
  Without that fix the guard was silently inert on every redirect-verify.
- **Webhook** — `{ Event, TransactionRef, Body: { amount, transaction_ref,
  transaction_status, meta, merchant_amount, payment_information,
  customer_mobile, ... } }`, signed with `x-squad-encrypted-body`.
- `Body.amount` is the **gross** charged; `merchant_amount` is what settles
  after Squad's cut. The underpayment guard compares against the gross. Do not
  change it to `merchant_amount`.

Two bugs this turned up, both now fixed:

- Card details (`payment_information`) and payer phone (`customer_mobile`) were
  reaching `payment_events`. The redaction list had been guessing at field names
  Squad does not use.
- `Abandoned` was not treated as a failure, so an abandoned checkout sat in the
  admin's list as pending forever.

## Still unanswered by Squad

1. **Which field routes settlement to a sub-merchant on `/transaction/initiate`?**
   `/Payments/Initiate-payment` is the only page that would say and it returns
   403 to every fetch; the aggregator pages cover creating a sub-merchant
   (returning `account_id`, e.g. `AGGERYG8WF34`) but never how to route a
   payment to one. **This is step 5's risk — get it in writing.**
2. Does the **0.25% / ₦1,000-cap** virtual-account rate apply to *dynamic*
   (one-time) accounts, or only dedicated ones?
3. With `pass_charge: true`, is the expected amount the gross or the net? We
   send `false` and gross up ourselves.

---

## Optional but recommended

- `RESEND_API_KEY` — not set on either environment, so the "payment received"
  email to school owners silently does not send. In-app notifications still work.
- `ALLOWED_REDIRECT_ORIGINS` — comma-separated. Only needed if you add a domain
  beyond the ones already hard-coded in `create-payment`
  (`eduledgerng.com`, `www.eduledgerng.com`, the Vercel URL, localhost).
