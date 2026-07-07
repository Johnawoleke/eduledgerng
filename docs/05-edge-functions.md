# 05 — Edge Functions Reference

EduLedgerNG's privileged server-side logic lives in fourteen Supabase (Deno) Edge Functions under `supabase/functions/`. Because the untrusted browser talks to Postgres directly with the anon key, anything that needs the **service role** (to bypass RLS), a **secret** (Paystack/Zendfi keys), or an **identity check the browser can't be trusted to make** is pushed into an edge function. This document is the exhaustive per-function reference: purpose, JWT gate, request/response shapes, caller authentication, DB side-effects, external calls, error paths, and observed debt.

> Sibling docs: schema/columns in `02-data-model.md`, RLS policies in `03-security-rls.md`, the Paystack money model in `07-payments.md`, and the student PIN-auth flow in `04-authentication.md`.

---

## 0. How edge functions fit together

- **Runtime**: Deno, each folder is one function with an `index.ts`. Two import styles coexist: newer functions use `Deno.serve(...)`, older ones import `serve` from `https://deno.land/std@0.168.0/http/server.ts`. Both are equivalent.
- **Supabase client**: every function creates a service-role client via `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`. **All fourteen functions use the service role and therefore bypass RLS entirely** — RLS is not a backstop inside these functions, so each function is solely responsible for its own authorization. The functions that must additionally know *who is calling* build a **second** client bound to the caller's `Authorization` header using `SUPABASE_ANON_KEY` and call `auth.getUser()`.
- **CORS**: every function answers `OPTIONS` with `Access-Control-Allow-Origin: *` and a permissive `Access-Control-Allow-Headers`. Origin is not restricted.
- **Secrets** (set only as edge-function secrets, never in the repo): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `PAYSTACK_SECRET_KEY`, `ZENDFI_API_KEY`/`ZENDFI_TEST_KEY`, `ZENDFI_WEBHOOK_SECRET`.

### `verify_jwt` — the gateway gate

`supabase/config.toml` sets `verify_jwt` per function. When `true` (the platform **default** for any function *not* listed in config.toml), the Supabase API gateway rejects the request before your code runs unless the `Authorization` header carries a valid Supabase JWT. When `false`, the function is publicly invokable and must do its own auth.

| Function | Listed in config.toml? | `verify_jwt` | Effective gateway gate |
|---|---|---|---|
| register-school | yes | `false` | none — public |
| student-auth | yes | `false` | none — public |
| student-payment | yes | `false` | none — public |
| change-pin | yes | `false` | none — public |
| student-set-pin | yes | `false` | none — public |
| create-paystack-payment | yes | `false` | none — public |
| verify-paystack-payment | yes | `false` | none — public |
| paystack-webhook | yes | `false` | none — public |
| create-zendfi-payment | yes | `false` | none — public |
| zendfi-webhook | yes | `false` | none — public |
| **add-bursar** | **no** | `true` (default) | valid Supabase JWT required |
| **remove-bursar** | **no** | `true` (default) | valid Supabase JWT required |
| **handle-school-request** | **no** | `true` (default) | valid Supabase JWT required |
| **check-user-exists** | **no** | `true` (default) | valid Supabase JWT required |

> NOTE: The four management functions rely on the *default* `verify_jwt=true` because they have no `[functions.<name>]` block in `config.toml`. If someone ever adds those blocks and omits `verify_jwt`, or the platform default changes, they silently become public. Their own in-code owner/invitee checks (below) still hold, except **check-user-exists**, which has no in-code check beyond the gateway JWT.

### Caller-check summary (the security-critical view)

| Function | Service role? | In-code caller check | Verdict |
|---|---|---|---|
| add-bursar | yes | JWT `getUser()` + owner-of-school check | OK |
| remove-bursar | yes | JWT `getUser()` + owner-of-school check + self/owner guard | OK |
| handle-school-request | yes | JWT `getUser()` + `request.user_id === caller.id` | OK |
| check-user-exists | yes | **none** beyond gateway JWT | ⚠ email-enumeration oracle for any logged-in user |
| register-school | yes | **none** (public, `verify_jwt=false`) | ⚠ see §1.5 |
| change-pin | yes | knowledge of `old_pin` (via RPC) | OK |
| student-set-pin | yes | knowledge of `current_pin` (via RPC) | OK |
| student-auth | yes | knowledge of `pin` (via RPC, with lockout) | OK |
| student-payment | yes | knowledge of `pin` (via RPC) | OK (legacy) |
| create-paystack-payment | yes | knowledge of `pin` (via RPC) | OK |
| verify-paystack-payment | yes | **none** — only a `reference`; safety comes from re-verifying with Paystack + idempotency | OK-by-design (see §3.2) |
| paystack-webhook | yes | HMAC-SHA512 signature | OK |
| create-zendfi-payment | yes | knowledge of `pin` (via RPC) | OK (legacy) |
| zendfi-webhook | yes | HMAC-SHA256 signature + replay window | OK (legacy) |

### LIVE vs LEGACY

- **LIVE**: register-school, add-bursar, remove-bursar, handle-school-request, check-user-exists, change-pin, student-set-pin, student-auth, create-paystack-payment, verify-paystack-payment, paystack-webhook.
- **LEGACY** (no UI path invokes them; kept for history / possible reactivation): **student-payment**, **create-zendfi-payment**, **zendfi-webhook**. Zendfi was the original crypto-onramp payment provider (per `CLAUDE.md`), replaced by the Paystack split-settlement flow. `student-payment` is the even-older direct `fee_items` writer.

---

## The shared dependency: `verify_student_pin` RPC

Six functions (student-auth, change-pin, student-set-pin, student-payment, create-paystack-payment, create-zendfi-payment) authenticate a student by calling the Postgres RPC `verify_student_pin`. Canonical definition: `supabase/migrations/20260707100000_fix_verify_student_pin_lockout.sql`.

- **Signature**: `verify_student_pin(p_school_id uuid, p_student_id text, p_pin text)`
- **`SECURITY DEFINER`**, `search_path = public`.
- **Returns** a table (0 or 1 row): `id uuid, student_id text, name text, class text, school_id uuid, session text, term text, must_change_pin boolean`. Note it returns the student's `class`, `session`, and `term` **string** columns and **does not** return the `pin`.
- **Behavior**: case-insensitive `upper(student_id)` match, scoped to `school_id`, excluding students whose `status = 'inactive'`. If the student is currently locked (`locked_until > now()`), it returns **no rows**. On PIN match it clears `failed_login_attempts`/`locked_until`. On mismatch it increments `failed_login_attempts` and, at **≥5** consecutive failures, sets `locked_until = now() + 15 minutes`.
- **Callers treat 0 rows as "invalid credentials"** — they cannot distinguish "wrong PIN" from "locked" from "inactive" from "no such student" (intentional).

> NOTE: PINs are stored and compared as **plaintext** (`v_pin = p_pin`). `students.pin` is plaintext in the DB (also flagged in `CLAUDE.md` as security debt). The lockout columns (`failed_login_attempts`, `locked_until`) were added by this same migration because production's `students` table lacked them and every login was 500-ing.

---

## 1. School & admin management

### 1.1 add-bursar

**File**: `supabase/functions/add-bursar/index.ts` · **LIVE** · `verify_jwt=true` (default) · service role.

**Purpose**: Owner adds a bursar (or another owner) to a school, in one of two modes depending on whether the target email already has an account.

**Request body**: `{ email, schoolId, role?, password?, fullName? }`. Required: `email`, `schoolId`. `role` defaults to `"bursar"`.

**Caller check** (lines 41–74): builds an anon client from the caller's `Authorization` header, `auth.getUser()` → 401 if not signed in. Loads the school; caller is an owner if `school.owner_id === caller.id` **or** there is a `school_admins` row with `(school_id, user_id=caller.id, role='owner')`. Otherwise 403 "Only school owners can add bursars".

**Target lookup** (lines 76–84): paginates `auth.admin.listUsers({ page, perPage: 1000 })` up to 20 pages, matching case-insensitively on email.

**Mode 2 — account does NOT exist** (lines 89–132): requires `password` (else 404 with `needsPassword: true`); password must be ≥6 chars. Creates the auth user (`email_confirm: true`, `user_metadata.full_name`), inserts `school_admins {school_id, user_id, role}` (**rolls back / deletes the orphan auth user if that insert fails**), then upserts a `profiles` row with `must_change_password: true`. Returns `{ success, created: true, userId, message }`.

**Mode 1 — account exists** (lines 134–187): rejects if already a member (400). Checks for an existing **pending** `school_requests` row: a still-valid one blocks a duplicate (400); an **expired** one is deleted and re-sent. Inserts a `school_requests` invitation `{school_id, user_id, requested_by: caller.id, role, status:'pending', expires_at: now+7 days}`. Returns `{ success, created: false, requestId, userId, message }`.

**DB side-effects**: `auth.users` (create/delete), `school_admins` (insert), `profiles` (upsert), `school_requests` (insert/delete). **External calls**: none.

**Error cases**: 400 missing fields / already-member / duplicate-invite / bad password, 401 not signed in, 403 not owner, 404 school-not-found / user-not-found-needs-password, 500 unexpected.

> NOTE: `CLAUDE.md`'s "Known issues" still says "`add-bursar` doesn't verify the caller owns the school" — that is **stale**; the current code does verify ownership (lines 61–74). The header comment confirms the check was added ("previously anyone could invoke this").

### 1.2 remove-bursar

**File**: `supabase/functions/remove-bursar/index.ts` · **LIVE** · `verify_jwt=true` (default) · service role.

**Purpose**: Off-board a member from a school and immediately kill their sessions.

**Request body**: `{ schoolId, userId }` (both required).

**Caller check** (lines 35–64): same owner-verification pattern as add-bursar → 401 / 403.

**Guards**: cannot remove yourself or the school's owner (`userId === caller.id || school.owner_id === userId` → 400 "You cannot remove an owner"). Target must be a `school_admins` member (else 404); if the target row's `role === 'owner'`, 400. This protects the last-owner invariant.

**Side-effects**: deletes the `school_admins` row, then **best-effort** `auth.admin.signOut(userId, "global")` so the removed user's existing JWT stops working (wrapped in try/catch — failure is swallowed). Returns `{ success: true }`. **External calls**: none.

### 1.3 handle-school-request

**File**: `supabase/functions/handle-school-request/index.ts` · **LIVE** · `verify_jwt=true` (default) · service role.

**Purpose**: The invitee accepts or declines a pending `school_requests` invitation.

**Request body**: `{ requestId, action }` where `action ∈ {"accept","decline"}` (else 400).

**Caller check** (lines 36–74): anon-client `getUser()` → 401 if not signed in. Loads the request; **only the invitee may act**: `request.user_id !== caller.id` → 403 "This invitation is not addressed to you". The header comment notes this closed a hole where "anyone holding a requestId could accept/decline it."

**Flow**: 404 if request not found. If `expires_at < now()`, marks the row `status:'expired'` and returns 400 "This request has expired". On `accept`, inserts a `school_admins {school_id, user_id, role}` row (skipped if already a member), then sets `status:'accepted'`. On `decline`, sets `status:'declined'`. Returns `{ success, action, message }`.

**Side-effects**: `school_requests` (update), `school_admins` (insert). **External calls**: none.

> NOTE: `err.message` is referenced in the catch without an `err instanceof Error` guard (line 141) — harmless but inconsistent with the newer functions.

### 1.4 check-user-exists

**File**: `supabase/functions/check-user-exists/index.ts` · **LIVE** · `verify_jwt=true` (default) · service role.

**Purpose**: Tell the register/add-bursar UI whether an email already has an account.

**Request body**: `{ email }` (else 400). **Response**: `{ exists: boolean }`.

**Implementation**: paginates `auth.admin.listUsers({ page, perPage: 1000 })` up to 20 pages, case-insensitive match.

**Caller check**: **none in code** — only the gateway `verify_jwt=true`. Any authenticated user can probe any email.

> ⚠ **Gotcha / debt**: This is an **email-enumeration oracle**. Any logged-in account can determine whether an arbitrary email is registered. Also, `listUsers` scanning is O(users) per call and caps at 20×1000 = 20,000 accounts; beyond that, `exists` can false-negative. Consider `auth.admin.getUserByEmail` (single lookup) if/when available.

### 1.5 register-school

**File**: `supabase/functions/register-school/index.ts` · **LIVE** · `verify_jwt=false` (public) · service role.

**Purpose**: Create a school (branch) and, optionally, its owner account; seed the first session + three terms.

**Request body** (accepts `schoolName` **or** `name`): `{ schoolName|name, slug, schoolCode, address?, phone?, schoolEmail?, email?, password?, fullName?, bankName?, accountNumber?, accountName?, owner_id? }`. **Required**: `schoolName/name`, `slug`, `schoolCode` (validated individually → 400 with a `received` echo).

**Two owner modes**:
- `owner_id` provided → existing user; verified via `auth.admin.getUserById` (404 "Owner user not found" if missing). No new auth user is created.
- No `owner_id` → new-user flow: requires `email`+`password`+`fullName` (400 if missing), password ≥6 chars (400). Creates the auth user (`email_confirm: true`) and upserts a `profiles` row (`id` = auth user id — **there is no `user_id` column**, per the live-schema drift).

**Flow**: slug uniqueness check (409 "This school link is already taken"). Inserts `schools` (`school_code` falls back to `slug.substring(0,4).toUpperCase()`; bank fields nullable). **If the school insert fails and this was a new user, the just-created auth user is deleted** (rollback). Re-selects the school id, inserts `school_admins {role:'owner'}`, and if no session exists yet, seeds one `sessions` row `${year}/${year+1}` with `is_current:true`, then three `terms` (Term 1 current, Terms 2–3 not). Returns `{ success: true, slug }`.

**Side-effects**: `auth.users` (create/delete), `profiles`, `schools`, `school_admins`, `sessions`, `terms`. **External calls**: none.

> ⚠ **Debt / gotchas**:
> - **Public + no caller check.** Because `verify_jwt=false` and there is no identity check, anyone on the internet can create schools. With `owner_id` supplied, a caller can create a school **owned by an arbitrary existing user id** (only existence is checked, not that the caller *is* that user). The frontend uses this legitimately (already-signed-in owner adds another branch), but nothing server-side enforces `owner_id === caller`.
> - **Verbose logging**: it `console.log`s the raw request body and parsed fields (lines ~14–20 and 50), which includes the plaintext `password` for the new-user flow. That lands in edge-function logs.
> - **Non-atomic**: school insert, `school_admins`, session, and terms are separate statements with no transaction; a mid-sequence failure can leave a school with no owner-admin or no session (only the school-insert failure rolls back the new auth user).

---

## 2. Student PIN auth & PIN management

### 2.1 student-auth

**File**: `supabase/functions/student-auth/index.ts` · **LIVE** · `verify_jwt=false` · service role.

**Purpose**: The student login endpoint. Verifies the student's PIN and returns the full dashboard payload (student, school, computed fee items, payments, sessions, terms).

**Request body**: `{ school_slug, student_id, pin, session_id?, term_id? }`. Required: `school_slug`, `student_id`, `pin`. Input validation: `student_id` ≤30, `pin` ≤10, `school_slug` ≤100 chars, all strings (else 400 "Invalid input").

**Flow**: resolve school by slug (404 if none, 500 on DB error) → `verify_student_pin` RPC (401 "Invalid Student ID or PIN" on 0 rows / lockout). Then:
- **Fees**: `class_fees` where `school_id`, `status='published'`, `class_target IN (student.class, 'ALL')`, optionally filtered by `session_id`/`term_id`. **Only `published` fees are ever returned** — this is the student-facing filter `CLAUDE.md` warns must exist in every student read path.
- **Payments**: all `payments` for `student.id`, ordered by `date` desc, optionally filtered by session/term.
- **Fee items computed server-side**: for each class fee it sums matching payment items. Payment `items` are stored as `"<name>|<amount>"` strings (pipe-delimited, split on the **last** `|`); `paid` per fee is `min(sum, amount)`, status ∈ `paid`/`partial`/`unpaid`.
- Also loads all `sessions` (id, name, years) and `terms` (id, session_id, name, term_number) for the school.

**Response**: `{ student, school, feeItems, payments, sessions, terms }`.

> NOTE: `student` here is the RPC row (no `pin`), but it is a full object echoed to the browser; it includes `must_change_pin`, `class`, `session`, `term`.

### 2.2 change-pin

**File**: `supabase/functions/change-pin/index.ts` · **LIVE** · `verify_jwt=false` · service role.

**Purpose**: A logged-in student changes their PIN (knows the current one).

**Request body**: `{ school_slug, student_id, old_pin, new_pin }` (all required). `new_pin` must match `/^\d{4}$/` — **exactly 4 digits** (400 otherwise).

**Flow**: resolve school (404) → `verify_student_pin(old_pin)` (401 "Invalid current PIN" on 0 rows) → `UPDATE students SET pin=new_pin, must_change_pin=false, is_first_login=false WHERE id=student.id`. Returns `{ success: true }`. **External calls**: none.

### 2.3 student-set-pin

**File**: `supabase/functions/student-set-pin/index.ts` · **LIVE** · `verify_jwt=false` · service role.

**Purpose**: First-login credential set. The header comment states it **replaces the old direct-from-browser `students` update in `ResetPassword.tsx`**, so the `students` table no longer needs an anon-writable UPDATE policy.

**Request body**: `{ school_slug, student_id, current_pin, new_pin }` (all required). `new_pin` must be a string of **4–50 chars** (looser than change-pin's strict 4 digits — this path allows an alphanumeric "password").

**Flow**: resolve school (404) → `verify_student_pin(current_pin)` (401 "Current PIN is incorrect") → `UPDATE students SET pin=new_pin, default_pin=new_pin, must_change_pin=false, is_first_login=false`. Returns `{ success: true }`.

> NOTE: This differs from change-pin in two ways: it also writes `default_pin`, and it accepts up to 50 chars. So a student who "sets" a password here can end up with a >4-char credential that change-pin (4-digit-only) can never subsequently change without going back through this endpoint. Worth reconciling.

---

## 3. Paystack payment flow (LIVE)

Money model recap (details in `07-payments.md`): student bears Paystack's processing fee via a **gross-up**; the school's own bank receives the fee amount minus a flat **1% platform cut** through a per-school Paystack **subaccount**; the platform keeps the 1% via `transaction_charge` with `bearer: "subaccount"`. All internal math is in **kobo** (1 NGN = 100 kobo).

### 3.1 create-paystack-payment

**File**: `supabase/functions/create-paystack-payment/index.ts` · **LIVE** · `verify_jwt=false` · service role. Requires `PAYSTACK_SECRET_KEY` (500 "Payment provider not configured" if unset).

**Request body**: `{ school_slug, student_id, pin, fee_payments, session_id?, term_id?, callback_url? }`. `fee_payments` is a non-empty array of `{ fee_item_id, amount }` (the `fee_item_id` is actually a **`class_fees.id`**). Validation: `student_id`≤30, `pin`≤50, `school_slug`≤100.

**Auth**: `verify_student_pin` (401 on failure).

**Fee validation** (lines 110–156): loads **published** `class_fees` for the class (`class_target IN (student.class,'ALL')`, optional session/term). Computes already-paid per fee name from existing `payments.items`. For each requested payment, clamps `amount` to `[0, owing]`; skips fees not found / fully paid. `baseAmountNGN` = sum of validated amounts (400 "No valid payments" if 0). **Students can never pay a `pending` fee** — same published-only guard.

**Money** (lines 158–161): `baseKobo = round(base*100)`; `platformFeeKobo = round(base*1%)`; `totalKobo = grossUpKobo(baseKobo)`; `processingFeeKobo = total - base`.
- `paystackFeeKobo(amt)`: `1.5% + ₦100`, the ₦100 waived under ₦2,500 (`amt < 250000` kobo), capped at ₦2,000 (`200000` kobo).
- `grossUpKobo(base)`: smallest total `T` such that `T − paystackFee(T) ≥ base`; closed-form estimate then a `+=100` correction loop. This math is **duplicated in `SchoolStudentDashboard.tsx`** and must stay in sync (per `CLAUDE.md`).

**Lazy subaccount provisioning** (lines 163–230): if `schools.settings.paystack_subaccount_code` is absent: require `bank_name` + `account_number` (400 otherwise) → `GET /bank?currency=NGN&perPage=100` (502 on failure) → fuzzy-match the bank via `normalizeBankName` (strips parentheticals and the words bank/of/nigeria/plc/the, keeps letters; matches on equality or substring either direction; 400 if unmatched) → `POST /subaccount` with `percentage_charge: 0` (502 on failure) → **cache** `paystack_subaccount_code` and `paystack_bank_code` back into `schools.settings` (JSONB, no schema change).

**Customer email** (lines 235–246): reads `students.parent_email`; if missing/malformed (regex, and rejects `.test` domains) it synthesizes `<sanitized student_id>@eduledgerng.ng` because Paystack validates the email strictly.

**Initialize** (lines 248–284): `POST /transaction/initialize` with `email`, `amount: totalKobo`, `currency:"NGN"`, a generated `reference` (`EDU-PS-<base36 time>-<6 hex>`), `subaccount`, `transaction_charge: platformFeeKobo`, `bearer:"subaccount"`, optional `callback_url` (only if string <500 chars), and a rich `metadata` object (`school_id`, `student_db_id`, `session_id`, `term_id`, and **`items: validatedItems`** — the metadata the webhook/verify later trust to record the payment). 502 if no `authorization_url` returned.

**Response**: `{ authorization_url, reference, base_amount, processing_fee, total_ngn }`. **No `payments` row is written here** — recording happens only after Paystack confirms (webhook/verify).

**External calls**: Paystack `/bank`, `/subaccount`, `/transaction/initialize`.

### 3.2 verify-paystack-payment

**File**: `supabase/functions/verify-paystack-payment/index.ts` · **LIVE** · `verify_jwt=false` · service role. Requires `PAYSTACK_SECRET_KEY`.

**Purpose**: The student dashboard calls this when Paystack redirects back with `?reference=`. It confirms the transaction with Paystack and records the payment if the webhook hasn't already.

**Request body**: `{ reference }` (string ≤100, else 400).

**Flow**: `GET /transaction/verify/<reference>` (404 `{success:false,status:"not_found"}` if not found). If `data.status !== "success"` returns `{success:false, status}` (200). **Idempotency**: if a `payments` row already exists for `reference`, returns `{success:true, recorded:true, already_processed:true}`. Otherwise reads `data.metadata` (must have `school_id`, `student_db_id`, `items`, else `{recorded:false, note:"no_metadata"}`), rebuilds `items` as `"<name>|<amount>"`, inserts a `payments` row (`method:"Paystack"`, optional session/term), and writes a `payment_events` audit row (`event_type:"verify.recorded"`, `payment_id: reference`). A concurrent-webhook insert race is caught and reported harmlessly via the unique index on `reference`.

**Response**: `{ success:true, recorded:true, amount }` (or one of the non-recording shapes above).

> **Caller check by design**: there is no PIN/JWT here — any `reference` can be posted. This is safe because (a) the function **re-verifies with Paystack** (an attacker can't fabricate a `success`), (b) the recorded amount/items come from Paystack's server-held `metadata`, not the request, and (c) inserts are idempotent on `reference`. The worst an attacker can do is force recording of a genuinely-successful payment that would have been recorded anyway.

### 3.3 paystack-webhook

**File**: `supabase/functions/paystack-webhook/index.ts` · **LIVE** · `verify_jwt=false` · service role. Requires `PAYSTACK_SECRET_KEY`. Point Paystack's webhook at `https://<project-ref>.supabase.co/functions/v1/paystack-webhook`.

**Auth**: **HMAC-SHA512** of the raw body with the secret key, compared **constant-time** against `x-paystack-signature` (401 "Invalid signature" on mismatch; 401 "not configured" if the secret is unset; empty body → 200 ignored).

**Flow**: parse JSON (400 on failure). **Audit-logs every verified event** into `payment_events` (`event_type`, `payment_id` = reference or `data.id`, `status`, `amount_usd:null`, full `payload`). Only acts on `event === "charge.success" && status === "success"` (else 200 ignored). Requires metadata `school_id`, `student_db_id`, `items` (else 200 `no_metadata`). Idempotent on `reference`. Sums positive item amounts, inserts a `payments` row (`method:"Paystack"`, optional session/term). Returns `{received:true, reference, amount}` (or 500 "Failed to record payment" on insert error).

**External calls**: none (Paystack calls *in*).

> NOTE: verify-paystack-payment and paystack-webhook are the two twice-safe recorders; both idempotent on `payments.reference` (unique index from the reconcile migration). Whichever lands first records; the other no-ops.

---

## 4. Zendfi payment flow (LEGACY)

Nothing in the current UI invokes these. Zendfi was a USD/USDC crypto-onramp provider. Documented for completeness and because the functions are still deployed and publicly invokable.

### 4.1 create-zendfi-payment

**File**: `supabase/functions/create-zendfi-payment/index.ts` · **LEGACY** · `verify_jwt=false` · service role.

**Request body**: `{ school_slug, student_id, pin, fee_payments, session_id?, term_id? }`.

**Flow**: resolves school, `verify_student_pin` (401), validates `fee_payments` against **published** `class_fees` (same paid-map/clamp logic and published-only guard as create-paystack-payment). **Fee model differs**: `platformFee = 1%`, `gatewayFee = 0.6%`, `bankCharge = 2%`, all **added on top** of base (student pays `base + 3.6%`), and the total is converted to USD at a **hardcoded ₦1500/USD** rate. Reads the key from `ZENDFI_API_KEY` or `ZENDFI_TEST_KEY` (500 if neither). `POST https://api.zendfi.tech/api/v1/payment-links` with `onramp:true`, `token:"USDC"`, customer email (`parent_email` or synthetic `<student_id>@<slug>.eduledgerng.ng`) and a `metadata` block mirroring the Paystack one. 502 on non-OK / missing `hosted_page_url`.

**Response**: `{ hosted_page_url, reference, amount_ngn, base_amount }`. `reference` format `EDU-<base36 time>`.

> ⚠ Debt: fixed FX rate, a different (higher, additive) fee model than Paystack, and no payment row written until the webhook lands.

### 4.2 zendfi-webhook

**File**: `supabase/functions/zendfi-webhook/index.ts` · **LEGACY** · `verify_jwt=false` · service role. Requires `ZENDFI_WEBHOOK_SECRET`.

**Auth**: **HMAC-SHA256**, constant-time, accepting **two signature formats** Zendfi's docs disagree on — Format A (`t=<unix>,v1=<hex>`, signed payload `<timestamp>.<body>`) and Format B (bare hex, timestamp in `X-ZendFi-Timestamp`, signed payload `<body>`). Enforces a **±300s replay window** when a timestamp is present (accepts seconds or ms). Tries both `<ts>.<body>` and `<body>` signed forms.

**Flow**: audit-logs to `payment_events` (with `amount_usd`). Success is detected leniently — normalized event name in a set (`paymentconfirmed`, `paymentsucceeded`, …) **or** payment status in `confirmed`/`succeeded`/`successful`/`completed`. Requires metadata `reference`, `school_id`, `student_db_id`, `items`. Idempotent on `reference`. Records a `payments` row with `method:"Bank Transfer (Zendfi)"`.

> ⚠ Debt: on a rejected/missing signature it **dumps all request headers** to the log (lines 120–122) — intended as debug, but it logs whatever a caller sends. The lenient event/status matching is broad by design because Zendfi's docs were inconsistent.

### 4.3 student-payment

**File**: `supabase/functions/student-payment/index.ts` · **LEGACY** · `verify_jwt=false` · service role.

**Purpose**: The oldest flow — records a payment **directly** with no external gateway, mutating the legacy per-student **`fee_items`** table.

**Request body**: `{ school_slug, student_id, pin, fee_payments }` (`fee_payments`: `{ fee_item_id, amount }[]`). Same input-length validation as student-auth.

**Flow**: resolve school, `verify_student_pin` (401). For each `fee_payments` entry, loads the `fee_items` row **scoped to `student_id`** (note: `fee_items`, *not* `class_fees` — it deliberately never touches the approval-gated table), clamps `amount` to `[0, owing]`, updates `fee_items.paid`/`status`, and accumulates a `"<name>|<amount>"` label (paid vs "(partial)"). Inserts one `payments` row (`method:"Online"`, `reference: PSK-<base36 time>`). Returns `{ payment, totalAmount, reference }`. 400 "No valid payments" if nothing applied.

> ⚠ Debt: `fee_items` has **no publish/approval flow** (unlike `class_fees`), so this path predates the fee-approval workflow. It writes to `payments` with no session/term columns. Kept only for history — `CLAUDE.md` confirms nothing in the UI calls it.

---

## 5. Cross-cutting gotchas & debt (summary)

| Area | Observation |
|---|---|
| Payment `items` encoding | Everything stores fee lines as `"<name>|<amount>"` strings split on the **last** `|`. A fee whose **name contains `|`** would parse wrong. This convention is replicated across student-auth, create-paystack-payment, create-zendfi-payment, both webhooks, verify, and student-payment — change it in all or none. |
| Duplicated gross-up math | `grossUpKobo`/`paystackFeeKobo` exist in both `create-paystack-payment/index.ts` and `SchoolStudentDashboard.tsx`; they must stay in sync or the displayed total won't match the charged total. |
| register-school | Public, no caller identity check, logs plaintext password, non-transactional multi-insert. |
| check-user-exists | Email-enumeration oracle for any authenticated user; `listUsers` scan caps at 20k accounts. |
| verify-paystack-payment | No caller check by design; safe only because it re-verifies with Paystack + idempotency. |
| PIN storage | Plaintext `students.pin`; `verify_student_pin` does `=` comparison. Lockout is 5 attempts → 15 min. |
| change-pin vs student-set-pin | Divergent new-credential rules (strict 4 digits vs 4–50 chars) and student-set-pin also writes `default_pin`. |
| Stale CLAUDE.md note | The "add-bursar doesn't verify the caller owns the school" line is out of date — it does. |
| CORS | All functions allow `*` origin. |
| Error `err.message` | handle-school-request and the older functions reference `err.message`/`error.message` without an `instanceof Error` guard, unlike the newer `json()`-helper functions. |
