# 07 — Payments Subsystem (Paystack Split Settlement)

EduLedgerNG collects Nigerian school fees through a **Paystack split-settlement** model: each school (a "branch") settles into its own bank account via a lazily-provisioned Paystack **subaccount**, the platform skims a flat **1%** off every transaction, and the paying student is **grossed-up** to absorb Paystack's gateway fee so the school always nets `fee − 1%`. Recording is idempotent on `payments.reference` and happens twice-safe via both the HMAC-verified `paystack-webhook` and the redirect-driven `verify-paystack-payment`. A legacy Zendfi/manual flow (`create-zendfi-payment`, `zendfi-webhook`, `student-payment`) still ships in the repo but is no longer wired to any UI.

> See `01-architecture.md` for the two-auth-system / multi-tenant overview, `03-security-rls.md` for the RLS floor these functions bypass with the service role, and the fee-approval doc for the `class_fees.status` pending→published lifecycle that gates every payment path.

---

## 1. Components at a glance

| Piece | Path | Role | Status |
|---|---|---|---|
| `create-paystack-payment` | `supabase/functions/create-paystack-payment/index.ts` | Validates fees, ensures subaccount, initializes Paystack transaction, returns `authorization_url` | **LIVE** |
| `verify-paystack-payment` | `supabase/functions/verify-paystack-payment/index.ts` | Called on redirect-back; confirms via `GET /transaction/verify`, records idempotently | **LIVE** |
| `paystack-webhook` | `supabase/functions/paystack-webhook/index.ts` | HMAC-SHA512-verified `charge.success` handler; records idempotently | **LIVE** |
| Student checkout UI | `src/pages/SchoolStudentDashboard.tsx` | Duplicates the gross-up math, drives the modal, invokes the two live functions | **LIVE** |
| `usePaymentEvents` | `src/hooks/usePaymentEvents.ts` | Realtime feed of the `payment_events` audit log | LIVE (admin UI) |
| `create-zendfi-payment` | `supabase/functions/create-zendfi-payment/index.ts` | Old USDC on-ramp checkout (₦→USD) | **LEGACY / dead UI** |
| `zendfi-webhook` | `supabase/functions/zendfi-webhook/index.ts` | Old Zendfi webhook (HMAC-SHA256, dual signature format) | **LEGACY / dead UI** |
| `student-payment` | `supabase/functions/student-payment/index.ts` | Oldest manual-record flow against `fee_items` | **LEGACY / dead UI** |

> A repo-wide grep of `src/` finds **no** `functions.invoke` call to `create-zendfi-payment`, `zendfi-webhook`, or `student-payment`. Treat the entire Zendfi triplet as dead code retained for history; the only live checkout is Paystack. CLAUDE.md's line 93 still describes the live flow as Zendfi — that comment is stale.

---

## 2. End-to-end happy path (step by step)

1. **Student opens the pay modal** (`SchoolStudentDashboard.tsx`). Fee items shown are `class_fees` minus prior payments, recomputed server-side by `student-auth` (the browser never queries `students`/`class_fees` for this). Only fees for the currently-selected session/term appear; a future (virtual) session blanks the list entirely (`academicPeriods.isFutureSession`).
2. **Student ticks fees and enters amounts.** Each input is clamped `0 … owing` where `owing = amount − paid` (`SchoolStudentDashboard.tsx:154-161`, `:402`).
3. **UI computes the gross-up** (`SchoolStudentDashboard.tsx:163-165`): `totalKobo = grossUpKobo(round(base*100))`, `processingFee = total/100 − base`, and shows a "School Fees / Card/Transfer Processing Fee / Total to Pay" breakdown (`:417-433`).
4. **Student clicks "Pay … with Paystack"** → `supabase.functions.invoke("create-paystack-payment", …)` with `{ school_slug, student_id, pin, fee_payments[], session_id, term_id, callback_url }` where `callback_url = ${origin}/school/${slug}/student` (`:451-461`).
5. **`create-paystack-payment` re-validates everything server-side** (never trusts the client's amounts):
   - Looks up the school by slug; verifies the student via the `verify_student_pin` RPC (school-scoped, PIN in plaintext — see §9).
   - Loads `class_fees WHERE status='published' AND class_target IN (student.class,'ALL')`, optionally filtered by `session_id`/`term_id`.
   - Loads prior `payments.items`, decodes the `Name|amount` encoding into a `paidMap` (§6), and re-clamps each requested payment to `min(requested, owing)`. Anything not matching a **published** fee id is silently dropped (`continue`).
   - Rejects with `400 "No valid payments"` if the validated base is `≤ 0`.
6. **Money math** (`create-paystack-payment/index.ts:158-161`): `baseKobo = round(base*100)`, `platformFeeKobo = round(baseKobo * 0.01)`, `totalKobo = grossUpKobo(baseKobo)`, `processingFeeKobo = totalKobo − baseKobo`.
7. **Subaccount ensure** (§4): reads `schools.settings.paystack_subaccount_code`; if missing, resolves the bank code from `schools.bank_name` and creates a subaccount from `schools.account_number`, then caches the code in `settings` JSONB.
8. **Transaction initialize** — `POST /transaction/initialize` with `amount=totalKobo`, `subaccount`, `transaction_charge=platformFeeKobo`, `bearer:"subaccount"`, a generated `reference`, and a rich `metadata` object (school/student ids, base amount, session/term, and the validated `items`). The customer email is the student's `parent_email` if it passes a strict regex and is not a `.test` address, else a synthetic `<studentid>@eduledgerng.ng` (`:242-246`).
9. **Function returns** `{ authorization_url, reference, base_amount, processing_fee, total_ngn }`; the UI redirects `window.location.href = authorization_url` (`SchoolStudentDashboard.tsx:471-473`).
10. **Student pays on Paystack's hosted page.** Two independent recording paths then fire:
    - **Webhook** (`paystack-webhook`): Paystack POSTs `charge.success`; the function verifies the HMAC-SHA512 signature and inserts the `payments` row.
    - **Redirect** (`verify-paystack-payment`): Paystack redirects back to `callback_url` with `?trxref=…&reference=…`; a `useEffect` (`SchoolStudentDashboard.tsx:54-79`) strips the query string, invokes `verify-paystack-payment`, and refreshes the dashboard.
11. **Idempotency** (§5) guarantees exactly one `payments` row per `reference` regardless of which path (or both, racing) lands first.

---

## 3. The money model (split + gross-up)

Three parties, one charge. All internal math is in **kobo** (₦1 = 100 kobo).

| Quantity | Formula | Who bears / receives it |
|---|---|---|
| `base` | Σ validated fee payments | Counts toward the student's fee balance |
| `platform_fee` | `round(base × 1%)` — the flat `transaction_charge` | Platform's **main** Paystack account |
| `paystack_fee` | 1.5% + ₦100, ₦100 waived under ₦2,500, capped at ₦2,000 | Paystack (the gateway) |
| `total charged` | `grossUp(base)` (smallest `T` with `T − paystackFee(T) ≥ base`) | **Student** pays this |
| `processing_fee` | `total − base` (≈ `paystack_fee`) | Student (visible line item) |
| School settlement | `base − platform_fee` | School's **subaccount** → its bank |

`PLATFORM_FEE_RATE = 0.01` (`create-paystack-payment/index.ts:26`). `bearer:"subaccount"` (`:261`) means Paystack deducts *its own* processing fee from the subaccount's settlement — but because the total was grossed-up to `base + paystack_fee`, the subaccount still nets exactly `base`, and then the `transaction_charge` pulls the 1% platform cut off the top. Net: **student pays `base + gateway_fee`; school's bank receives `base − 1%`; platform keeps `1%`.**

> Subtlety worth stating plainly: the student pays the gateway fee, but the **platform** absorbs nothing and the **school** absorbs the 1%. The school does *not* see the gateway fee at all (it was pre-funded by the gross-up).

---

## 4. Per-school Paystack subaccount (lazy provisioning)

One school row = one subaccount. Provisioned on the **first** payment for that school and cached forever after.

**Trigger:** `settings.paystack_subaccount_code` is absent (`create-paystack-payment/index.ts:164-167`).

**Preconditions:** `schools.bank_name` **and** `schools.account_number` are both non-null, else `400` with a "school has not set up its bank account…" message (`:168-173`). Relevant `schools` columns (all nullable, from `types.ts:292-304`): `bank_name`, `account_number`, `account_name`, `settings` (JSONB).

**Steps:**

| # | Action | Failure → response |
|---|---|---|
| 1 | `GET /bank?currency=NGN&perPage=100` (Bearer = `PAYSTACK_SECRET_KEY`) | `502` "Could not load bank list…" |
| 2 | Fuzzy-match `bank_name` to a Paystack bank via `normalizeBankName` (lowercase, strip parens, drop the words `bank/of/nigeria/plc/the`, keep only `[a-z]`; then exact / substring either-way match) | `400` "Could not match the school's bank…" |
| 3 | `POST /subaccount` with `business_name=school.name`, `settlement_bank=bank.code`, `account_number`, `percentage_charge:0`, `description` | `502` with Paystack's message (e.g. account/bank mismatch) |
| 4 | Cache `settings.paystack_subaccount_code` **and** `settings.paystack_bank_code` back onto the `schools` row (JSONB spread — no schema change) | — |

**`percentage_charge:0`** is deliberate — the platform's cut is taken per-transaction via `transaction_charge`, *not* via a standing subaccount percentage.

**Gotchas:**
- The fuzzy bank match (`:184-188`) is best-effort. A `bank_name` that normalizes to a substring of the wrong bank (e.g. very short tokens) could mis-match; the `account_number`↔bank validation at subaccount-creation time (step 3) is the real safety net.
- The cached `settings` write (`:220-229`) does a **full replace** of `settings` with a spread of the in-memory copy. Concurrent writers to `settings` from elsewhere could clobber each other, but nothing else writes `schools.settings` for these keys today.
- Once cached, a school that later changes its bank in Settings will keep settling to the **old** subaccount — there is no cache-invalidation path. Changing settlement banks requires manually clearing `settings.paystack_subaccount_code`.

---

## 5. Idempotency (`payments.reference`)

The uniqueness guarantee is a **partial unique index** created by the reconcile migration (`supabase/migrations/20260706130000_reconcile_live_schema.sql:27-28`):

```sql
create unique index if not exists payments_reference_key
  on public.payments (reference) where reference is not null;
```

Both recording paths do the same two-step guard:

1. **Pre-check:** `SELECT id FROM payments WHERE reference = ?` → if found, short-circuit (`paystack-webhook:105-110` returns `already_processed:true`; `verify-paystack-payment:56-61` returns `already_processed:true`).
2. **Insert:** if the pre-check missed but a concurrent path already inserted, the unique index rejects the second insert. The webhook treats that as a hard `500` (`:133-137`); **verify treats it as benign** and returns `success:true, recorded:false, note:<error>` (`:90-96`), because a racing webhook is expected.

**Reference format:** `EDU-PS-<base36 timestamp>-<6 hex chars>` (`create-paystack-payment:233`), e.g. `EDU-PS-LXYZ12AB-3F9C1D`. Generated server-side and echoed into both the transaction `reference` and its `metadata.reference`.

> The webhook returning `500` on a lost insert race means Paystack will **retry** the webhook. That retry then hits the pre-check (row now exists) and returns `already_processed`. So the race is self-healing, just noisy.

---

## 6. `payments.items` — the `Name|amount` encoding

`payments.items` is a `text[]` (reconcile migration `:19`; `types.ts:144`). Each element is `"<fee name>|<amount in ₦>"`, e.g. `"Tuition|50000"`, `"PTA Levy|2500"`. Both recording paths build it identically:

```ts
itemNames.push(`${item.name}|${payAmount}`);   // paystack-webhook:118, verify:75
```

**Decoding** (in `create-paystack-payment:132-137` and legacy zendfi) uses `lastIndexOf("|")` — so a fee **name containing a `|`** is decoded on the *last* pipe, keeping the name intact as long as the amount has no pipe. The decoded `paidMap[name] += amount` aggregates prior payments **by fee name**, which is how partial-payment "owing" is computed.

| Column | Type | Written by live flow? | Notes |
|---|---|---|---|
| `amount` | numeric (default 0) | Yes — `totalBaseAmount` (the **base**, not the grossed-up total) | Reconcile added this (`:16`) |
| `amount_paid` | numeric (nullable) | No (legacy) | Back-filled from `amount_paid`→`amount` once (`:24`) |
| `reference` | text | Yes | Unique-indexed |
| `method` | text | Yes — `"Paystack"` | |
| `items` | text[] | Yes | `Name|amount` encoding |
| `session_id` / `term_id` | uuid (nullable) | Only if present in metadata | Conditionally set (`:87-88`, `:130-131`) |
| `date` | timestamptz | default `now()` | |

> `amount` records the **base** fee value, *not* what the student was charged. The gateway fee and the 1% cut are **not** stored on the `payments` row — they live only in Paystack and in the transaction `metadata`. Reconciling platform revenue requires Paystack's dashboard, not this table.

---

## 7. Published-fee-only gate

Every student-facing payment path filters `class_fees` to `status='published'`:

| Path | Line |
|---|---|
| `student-auth` (fee summary the student sees) | (in `student-auth/index.ts`) |
| `create-paystack-payment` | `:115` — `.eq("status", "published")` |
| `create-zendfi-payment` (legacy) | `:67` — `.eq("status", "published")` |

An unmatched/pending fee id in `fee_payments` is silently skipped (`continue` at `:147`), so a student cannot pay a `pending` fee even by forging the id. **Any new student-facing read of `class_fees` MUST add this filter** (CLAUDE.md line 62). Published fees are also immutable for the whole session via the `protect_published_class_fees` DB trigger — see the fee-approval doc.

---

## 8. The gross-up formula (AUTHORITATIVE — keep in sync)

This is the single most sync-sensitive piece of the subsystem. The **identical** code exists in two places and must not diverge:

- `supabase/functions/create-paystack-payment/index.ts:30-45`
- `src/pages/SchoolStudentDashboard.tsx:24-37`

```ts
// Paystack NGN pricing: 1.5% + ₦100, the ₦100 waived under ₦2,500, capped at ₦2,000.
const paystackFeeKobo = (amountKobo: number): number => {
  let fee = 0.015 * amountKobo;
  if (amountKobo >= 250_000) fee += 10_000;      // +₦100 once total ≥ ₦2,500
  return Math.min(Math.ceil(fee), 200_000);      // cap ₦2,000
};

// Smallest total T such that T - paystackFee(T) >= base.
const grossUpKobo = (baseKobo: number): number => {
  // (dashboard adds a `if (baseKobo <= 0) return 0;` guard first)
  let total =
    baseKobo >= 246_250
      ? Math.ceil((baseKobo + 10_000) / 0.985)   // closed-form incl. ₦100
      : Math.ceil(baseKobo / 0.985);             // closed-form excl. ₦100
  if (0.015 * total + 10_000 > 200_000) total = baseKobo + 200_000;  // cap branch
  while (total - paystackFeeKobo(total) < baseKobo) total += 100;    // correction loop
  return total;
};
```

**How it works:** solve `T − (0.015·T [+ 100]) ≥ base` for `T`. The closed form (`base/0.985`, or `(base+100)/0.985` once the ₦100 applies) gets within a few kobo; the `while` loop then nudges `T` up in ₦1 (100-kobo) steps until the settled amount `≥ base`, absorbing all rounding. The cap branch handles amounts where the fee would exceed the ₦2,000 ceiling — there the gross-up is simply `base + ₦2,000`.

**Constants:**

| Constant | Value | Meaning |
|---|---|---|
| `0.015` | 1.5% | Paystack percentage fee |
| `10_000` kobo | ₦100 | Paystack flat fee |
| `250_000` kobo | ₦2,500 | Threshold above which the ₦100 applies (to the **total**) |
| `246_250` kobo | ₦2,462.50 | Base threshold picking the closed-form branch |
| `200_000` kobo | ₦2,000 | Fee cap |

### Worked examples (computed from the exact code)

| Base (₦) | Total charged (₦) | Processing fee (₦) | Paystack fee on total (₦) | Settled to subaccount (₦) | Platform 1% (₦) | School net (₦) |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1,015.23 | 15.23 | 15.23 | 1,000.00 | 10.00 | 990.00 |
| 2,000 | 2,030.46 | 30.46 | 30.46 | 2,000.00 | 20.00 | 1,980.00 |
| 5,000 | 5,177.67 | 177.67 | 177.67 | 5,000.00 | 50.00 | 4,950.00 |
| 50,000 | 50,862.95 | 862.95 | 862.95 | 50,000.00 | 500.00 | 49,500.00 |
| 100,000 | 101,624.37 | 1,624.37 | 1,624.37 | 100,000.00 | 1,000.00 | 99,000.00 |
| 150,000 | 152,000.00 | 2,000.00 | 2,000.00 (capped) | 150,000.00 | 1,500.00 | 148,500.00 |
| 500,000 | 502,000.00 | 2,000.00 | 2,000.00 (capped) | 500,000.00 | 5,000.00 | 495,000.00 |
| 1,000,000 | 1,002,000.00 | 2,000.00 | 2,000.00 (capped) | 1,000,000.00 | 10,000.00 | 990,000.00 |

In every case `settled == base` exactly (the gross-up's invariant) and `school net == base × 0.99`.

**Boundary notes / gotchas:**
- The ₦100-waiver threshold in `paystackFeeKobo` keys off the **total** being `≥ ₦2,500`, while `grossUpKobo`'s branch keys off the **base** being `≥ ₦2,462.50`. These don't coincide, but the `while` correction loop makes the final result correct regardless — the closed form is only a seed.
- The cap effectively engages once the uncapped fee would exceed ₦2,000, i.e. around base ≈ ₦125k+ (`0.015·T + 100 > 2000` ⇒ `T > ₦126,666.67`).
- The dashboard has an extra `if (baseKobo <= 0) return 0;` guard (`:31`) that the edge function omits. Harmless (the edge function only calls `grossUp` after asserting `base > 0`), but it is a **real code difference** between the "must stay in sync" twins — watch it if you refactor.
- `processingFee` shown to the user is `total/100 − base` (dashboard `:164`), which equals the Paystack fee to the kobo; the label calls it "Card/Transfer Processing Fee" (`:424`).

---

## 9. Assumptions & constraints

- **The browser is untrusted.** All fee amounts sent from the client are re-derived server-side against published `class_fees` and prior payments; the client's numbers are advisory only. RLS is the floor (see `03-security-rls.md`) but these functions run with the **service role** and bypass it.
- **PIN is verified in plaintext** via `verify_student_pin(p_school_id, p_student_id, p_pin)`. The pay path re-sends the PIN on every call (there is no bearer session for students). Known security debt: `students.pin` is plaintext and anon-readable (CLAUDE.md line 92).
- **Single currency:** NGN only. `currency:"NGN"` is hard-coded (`:257`).
- **One subaccount per school**, keyed by `schools.id`, cached in JSONB. No support for a school changing banks without manual cache clearing (§4).
- **`payments.reference` is the idempotency key** and must remain unique-indexed. Removing that index breaks double-recording safety.
- **Session/term are optional** on the payment; if absent, the fee validation and the recorded row are un-scoped. The UI always passes them from `academicPeriods`.
- **`callback_url`** is passed through only if it is a string under 500 chars (`:262`), else omitted (Paystack falls back to the dashboard-configured callback).

---

## 10. Failure modes

| Failure | Where detected | HTTP | User-visible effect |
|---|---|---|---|
| `PAYSTACK_SECRET_KEY` missing | `create-paystack-payment:80`, `verify:33`, webhook `:54` | 500 / 401 | "Payment provider not configured"; webhook **rejects** (401) so no recording |
| School slug not found | `create:97` | 404 | "School not found" |
| Bad PIN / student not found | `create:105` | 401 | "Invalid credentials" |
| No published fee matches any requested id | `create:156` | 400 | "No valid payments" |
| School has no `bank_name`/`account_number` | `create:168` | 400 | "…has not set up its bank account…" (asks owner to add details) |
| Bank list fetch fails | `create:180` | 502 | "Could not load bank list from payment provider" |
| Bank name can't be matched | `create:189` | 400 | "Could not match the school's bank…" (asks owner to re-select) |
| Subaccount creation fails (e.g. account# ≠ bank, **unactivated Paystack business**) | `create:211` | 502 | Paystack's message, e.g. "…Check that the account number matches the selected bank." |
| `transaction/initialize` fails (unactivated business, bad key) | `create:281` | 502 | Paystack's message or "Failed to start payment" (with `details`) |
| Webhook signature mismatch / missing | webhook `:62` | 401 | Silently dropped by Paystack-side; logged `signature mismatch` |
| Webhook `charge.success` missing metadata | webhook `:99` | 200 | `note:"no_metadata"` — **no** payment row, but the event **is** audit-logged |
| verify: transaction not `success` | `verify:46` | 200 | `{success:false, status}`; UI toasts "not completed" / "still processing" (`SchoolStudentDashboard.tsx:66-73`) |
| Concurrent insert race | webhook `:133` / verify `:90` | 500 / 200 | Webhook 500 → Paystack retries → resolves; verify treats as benign |

**Notable resilience choices:**
- Every verified webhook event is written to `payment_events` **before** the `charge.success` filter (`paystack-webhook:85-91`), so even ignored events (`charge.failed`, etc.) leave an audit trail. `payment_events.payment_id` is set to the `reference` (falling back to `data.id`); `amount_usd` is explicitly `null` (a leftover Zendfi column — payments here are NGN).
- `verify-paystack-payment` records a `verify.recorded` event only on a **successful** insert (`:98-103`); a race-lost insert does not.
- If `charge.success` arrives but metadata lacks `items`/ids (e.g. a transaction not created by our function), both paths log and skip rather than crash.

---

## 11. Data model reference

**`payments`** — baseline (`20260706120000_baseline_live_schema.sql:169-178`): `id, school_id, student_id, date, session_id, term_id, created_at, amount_paid`. Reconcile adds (`20260706130000:16-19`): `amount numeric not null default 0`, `reference text`, `method text`, `items text[] not null default '{}'`. Unique partial index on `reference`. RLS: `eduledger_payments_select … using (true)` — **anon-readable** (reconcile `:143-145`); writes are service-role only.

**`payment_events`** — audit log (`baseline:183-191`): `id, event_type, payment_id (text), status, amount_usd (numeric), payload (jsonb), created_at`. Added to the `supabase_realtime` publication (`baseline:195`) and consumed by `usePaymentEvents.ts` (realtime `INSERT` subscription on channel `payment_events_realtime`). RLS: `eduledger_payment_events_select … using (true)` (`baseline:284`).

**`schools`** settlement columns: `bank_name`, `account_number`, `account_name`, `settings` (JSONB). Subaccount keys cached under `settings.paystack_subaccount_code` and `settings.paystack_bank_code`.

`src/integrations/supabase/types.ts` is hand-reconciled against the live schema — keep it in sync when columns change.

---

## 12. Legacy Zendfi flow (for context only — do not extend)

`create-zendfi-payment` grossed differently: it **added** three explicit charges instead of solving for a gross-up — `platform 1%` + `gateway 0.6%` + `bank 2%` (`create-zendfi-payment/index.ts:115-118`), then converted the NGN total to USD at a hard-coded **₦1,500/USD** (`:141`) and created a Zendfi USDC on-ramp payment link. `zendfi-webhook` verifies HMAC-**SHA256** and accepts **two** different Zendfi signature header formats (`t=…,v1=…` vs bare hex, with a 300s replay tolerance). `student-payment` is an even older path that records against the legacy `fee_items` table with no gateway at all.

**Why it's dead:** no `src/` code invokes any of the three. The live UI (`SchoolStudentDashboard.tsx`) calls only `create-paystack-payment` and `verify-paystack-payment`. The Zendfi secrets (`ZENDFI_TEST_KEY`/`ZENDFI_API_KEY`, `ZENDFI_WEBHOOK_SECRET`) may still be set but are unused by the live flow.

> Debt to be aware of: the ₦1,500/USD FX rate and the additive fee model in the Zendfi path are both stale and would over/under-charge if ever re-enabled. Do not resurrect without a rewrite.

---

## 13. Sync & maintenance checklist

- [ ] **Gross-up parity:** any edit to `grossUpKobo`/`paystackFeeKobo` must be applied to **both** `create-paystack-payment/index.ts:30-45` and `SchoolStudentDashboard.tsx:24-37`. There is no shared module — this is copy-paste code by design (edge functions can't import from `src/`).
- [ ] **Paystack pricing drift:** if Paystack changes 1.5% / ₦100 / ₦2,500 waiver / ₦2,000 cap, update the four constants (§8) in both files.
- [ ] **Published-fee filter:** every new student-facing `class_fees` read gets `.eq("status","published")` (§7).
- [ ] **`reference` unique index** must survive any `payments` schema change (§5).
- [ ] Keep `types.ts` reconciled with live `payments`/`payment_events`/`schools` columns.
