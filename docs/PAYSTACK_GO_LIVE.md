# Going live on Paystack — production runbook

Production is `ifonivphhfplntzshtsb` ("Johnawoleke's Project").

Supersedes `SQUAD_GO_LIVE.md`. Squad was routed from 2026-08-06 and removed on
2026-08-17 **without ever settling a payment** — verified: zero schools ever had
a `squad_sub_merchant_id`, so sub-merchant provisioning never completed and no
`payments` row references it. Nothing has to be migrated or reconciled.

> ## ⚠️ Never put `PAYSTACK_SECRET_KEY` in `.env.local`
>
> That file feeds Vite. Anything in it prefixed `VITE_` is compiled into the
> JavaScript bundle every visitor downloads, and the whole file is for local dev
> only — edge functions never read it. The key belongs in Supabase edge function
> secrets and nowhere else. Do not paste it into a chat, a commit, or a ticket.

## What does NOT need doing

- **No migrations.** `payments.gateway` and `payments.expected_total_kobo`
  already exist on production and are already backfilled. The
  `guard_school_settlement_settings` trigger still lists the Squad settlement
  keys in its protected array; that is harmless — those keys are never written
  now — so migration `20260806110000` is left exactly as applied.
- **No re-provisioning.** `settlementKey()` has always kept each provider's id
  under its own key, so the two schools that were provisioned before the Squad
  episode still hold valid `paystack_subaccount_code` values and will settle on
  their next payment with no action. The other 29 provision lazily on first use.

---

## Step 1 — Confirm the Paystack secret is a LIVE key

```sh
supabase secrets list --project-ref ifonivphhfplntzshtsb
```

`PAYSTACK_SECRET_KEY` is already set (it has been powering the `/bank` lookup
throughout). Values are shown hashed, so confirm in the **Paystack dashboard**
that the key you set is the live one (`sk_live_…`) and not a test key — a test
key takes payments that never settle anywhere real.

`SQUAD_SECRET_KEY` and `SQUAD_ENV` are now unused. Delete them for hygiene:

```sh
supabase secrets unset SQUAD_SECRET_KEY SQUAD_ENV --project-ref ifonivphhfplntzshtsb
```

---

## Step 2 — Deploy the changed functions

```sh
supabase functions deploy create-payment verify-payment paystack-webhook \
  --project-ref ifonivphhfplntzshtsb
```

Then remove the Squad webhook, which no longer exists in the repo. Deleting the
source files does NOT remove it from the hosted project:

```sh
supabase functions delete squad-webhook --project-ref ifonivphhfplntzshtsb
```

Confirm the shape of the world:

```sh
for f in create-payment verify-payment paystack-webhook squad-webhook; do
  printf '%-22s %s\n' "$f" "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
    https://ifonivphhfplntzshtsb.supabase.co/functions/v1/$f)"
done
# expect 200, 200, 200, 404
```

---

## Step 3 — Point Paystack's webhook at us

Paystack dashboard → Settings → API Keys & Webhooks → Webhook URL:

```
https://ifonivphhfplntzshtsb.supabase.co/functions/v1/paystack-webhook
```

Without this, payments still complete but only settle when the payer is
redirected back to the dashboard. Anyone who closes the tab mid-payment is never
credited until they revisit — and with the fix in `verify-payment`, an
unconfirmed transfer now correctly stays `pending` rather than being written
off, which makes the webhook the thing that actually closes it out.

Verify a signature failure is rejected (it should be — this proves the endpoint
is reachable and the HMAC check is live):

```sh
curl -s -X POST https://ifonivphhfplntzshtsb.supabase.co/functions/v1/paystack-webhook \
  -H "Content-Type: application/json" -d '{}'
# expect {"error":"Invalid signature"}
```

---

## Step 4 — Deploy the frontend

Push to `main`; Vercel builds production in ~2 minutes. The frontend change is
the checkout breakdown, which now quotes Paystack's rate.

**Order matters:** functions before frontend. The two are compatible in both
directions here (nothing about the request shape changed), so this is not the
tight coupling the 2026-08-03 rollout had.

---

## Step 5 — THE TEST THAT MATTERS: one small real payment

**Do this before any parent is told to pay.**

1. Pick or create a school whose bank account **you** control.
2. Add a student to it, give them a fee of about **₦100**.
3. Pay it for real, end to end.
4. Then check:

```sql
-- (a) did it record, against the right gateway, for the right amount?
select reference, gateway, status, amount, expected_total_kobo, method, date
from public.payments order by date desc limit 5;

-- (b) did the webhook arrive and verify? (a signature failure writes nothing)
select event_type, status, created_at
from public.payment_events order by created_at desc limit 10;

-- (c) was a subaccount actually provisioned, against the RIGHT bank?
select slug,
       settings->>'paystack_subaccount_code' as subaccount,
       settings->>'paystack_bank_code'       as bank_code,
       bank_name
from public.schools where slug = '<your test school>';
```

5. **Then check the Paystack dashboard**: confirm the money split — the school's
   subaccount receives the fee, and your main account keeps the 1%
   `transaction_charge`. This split is the part that was NOT happening under
   Squad, so it is the specific thing worth eyeballing.

### Watch the bank code in (c)

The bank-name matcher was rewritten on 2026-08-17 (`_shared/bankNames.ts`)
because the old one resolved **First City Monument Bank** to **First Bank of
Nigeria**'s code. Two production schools bank with FCMB and have never taken a
payment, so they will provision for the first time on this rate. If a school's
resolved `bank_code` looks wrong for its `bank_name`, stop — a subaccount is
cached once created, and every later payment settles wherever it points.

---

## Step 6 — Clean up, once step 5 passes

```sh
supabase functions delete create-paystack-payment --project-ref ifonivphhfplntzshtsb
supabase functions delete verify-paystack-payment --project-ref ifonivphhfplntzshtsb
```

These are the pre-gateway-layer originals, superseded by `create-payment` /
`verify-payment`. The deployed frontend has not called them since 2026-08-06.
Their source is still in the repo; delete it in the same change if you want them
gone for good.

---

## Still outstanding, unrelated to the gateway

- **Supabase Auth URL configuration.** Site URL on production still points at a
  Vercel deployment URL that sits behind Vercel Deployment Protection, so
  password-recovery mails send owners to an SSO "request access" page. Fix in
  Authentication → URL Configuration: Site URL `https://www.eduledgerng.com`,
  and add `https://www.eduledgerng.com/**` and `https://eduledgerng.com/**` to
  Redirect URLs. `supabase/config.toml` documents the intent but cannot be
  pushed.
- `RESEND_API_KEY` — not set on either environment, so the "payment received"
  email to school owners silently does not send. In-app notifications still work.
- `ALLOWED_REDIRECT_ORIGINS` — comma-separated. Only needed if you add a domain
  beyond the ones already hard-coded in `create-payment`
  (`eduledgerng.com`, `www.eduledgerng.com`, the Vercel URL, localhost).
