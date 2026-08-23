# Payment testing runbook

Two halves. The first is automated; the second cannot be, and pretending
otherwise is how "invalid subaccount" reached production.

## 1. Automated — `npm run test:payments`

Drives the **deployed staging functions** end to end: creates a real pending
payment through `create-payment`, signs a webhook with the same key the staging
function verifies against, POSTs it, and reads the row back. It cleans up
everything it writes.

### Setup

Two secrets, in `.env.local` (git-ignored):

```sh
STAGING_SERVICE_ROLE_KEY=...   # Supabase → staging → Settings → API → service_role
PAYSTACK_TEST_SECRET_KEY=sk_test_...
```

`PAYSTACK_TEST_SECRET_KEY` **must be the same key set as the staging function
secret**, or every signature is rejected and the whole suite fails at the gate:

```sh
npx supabase secrets set PAYSTACK_SECRET_KEY=sk_test_... # staging is the default link
```

The suite skips itself with a named reason when either is absent, so it never
breaks `npm test` for anyone. It is deliberately **not** in CI: it writes to
staging and depends on a third-party sandbox.

### What it covers

- HMAC-SHA512 signature accepted / rejected / absent
- Exact payment settles and credits the billed amount, keyed by fee id
- Replay is idempotent (webhook + redirect-verify both firing credits once)
- Short payment credits nothing and records a reason
- A gateway reporting no amount credits nothing
- `bank.transfer.rejected` marks failed, with the reference read from **either**
  the top level or nested under `bank_transfer`
- A non-terminal transfer event never writes off a live payment
- Unknown events are acknowledged and change nothing
- `create-payment` reaches Paystack, clamps inflated amounts, refuses fees the
  student was never charged, and rejects a bad session token

## 2. Manual — the part no test can reach

**A bank transfer of the wrong amount cannot be automated.** Paystack's checkout
account is scoped to one amount by design, so producing a mismatch needs a
person with a bank app. The payloads in the automated suite are correctly signed
but written by us; if Paystack's real body differs from what published
integrations describe, the suite passes and production still does nothing.

Run these once, in **test mode**, before relying on the flow. Example checkout
of ₦512.70:

| Send | Expect |
|---|---|
| ₦512.70 | payment succeeds, fee marked paid, balance drops |
| ₦500 | rejected, Paystack refunds within 24h, fee NOT paid, reason shown |
| ₦600 | rejected, Paystack refunds within 24h, fee NOT paid, reason shown |

After each, read what Paystack actually sent — `payment_events` logs **every**
verified webhook whether or not we act on it:

```sql
select event_type, status, payload, created_at
from payment_events
order by created_at desc
limit 10;
```

That is the only way to confirm the real event name and payload shape. If
`bank.transfer.rejected` arrives with the reference somewhere neither the top
level nor `bank_transfer` covers, `referenceFromWebhook` in
`_shared/paymentOutcome.ts` is the one place to fix.

### Also confirm, once, per environment

- The **live** webhook URL points at that project's `paystack-webhook`. Paystack
  keeps live and test webhooks separately. Miss it and money is collected and
  never recorded — the worst failure available.
- A school that transacted under a TEST key holds a test subaccount code in
  `school_settlement.settings`, which does not exist under a live key. Clearing
  it re-provisions on the next payment.
