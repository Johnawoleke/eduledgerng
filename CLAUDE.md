# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

EduLedgerNG — a multi-tenant school fee management app for Nigerian schools. School owners register schools, manage students/fees per academic session and term, and collect payments; students log in with a student ID + password to view balances and pay via Paystack. Originally scaffolded by Lovable (Vite + React 18 + TypeScript + shadcn/ui + Tailwind), backed by Supabase, deployed on Vercel.

## Commands

Use **npm** (bun.lock exists but bun is not installed locally).

```sh
npm run dev          # dev server on http://localhost:8080
npm run build        # production build (Vite only — does NOT typecheck)
npm run lint         # eslint
npm test             # vitest run (all tests)
npm run test:watch   # vitest watch mode
npx vitest run src/test/example.test.ts   # single test file
npx tsc -b --noEmit  # typecheck (currently fails — see Known Issues)
```

Tests live in `src/**/*.{test,spec}.{ts,tsx}` (jsdom, globals enabled, setup in `src/test/setup.ts`). Path alias: `@/` → `src/`.

## Architecture

### Two parallel auth systems

1. **Admins/owners/bursars** use real Supabase email+password auth (`src/lib/supabaseAuthContext.tsx`). A `profiles` row is created per user; `school_admins` links users to schools with a role (`owner` or `bursar`). One admin account can own/manage multiple schools. Flow: create admin account (`/register`) → register schools → `/main-dashboard` (`src/pages/Dashboard.tsx`) lists all schools the user has a role in.

2. **Students** do NOT use Supabase auth. They log in with `student_id` + a password, validated server-side by the `student-auth` edge function against the `verify_student_pin` RPC.

   `students.pin` is a **bcrypt digest**, hashed on write by the `hash_student_pin` trigger (migration 20260803110000) — so callers still assign a plaintext value and the database stores the hash, and nothing outside `verify_student_pin` can check a password. `students.default_pin` holds the plaintext one-time temporary password the school issued (so an owner can read it back and hand it over) and is set to NULL the moment the student sets their own.

   On success `student-auth` mints an **opaque session token** (32 random bytes; only its SHA-256 digest is stored, in `student_sessions`, which has RLS on and no policies). `src/lib/schoolContext.tsx` keeps it under `pity_session` with its expiry. Every later privileged call — dashboard refresh, checkout — carries the token, NOT the password. Do not reintroduce password re-sending: the old scheme kept the student's password in localStorage forever with nothing to revoke.

   Guardrails that must stay: `student-auth` returns **no data and no token** while `must_change_pin` is set (enforcing first-login rotation server-side, not just in the router); credential attempts are throttled per IP by `student_auth_throttle_check` before any lookup; `verify_student_pin` keeps its 5-strike/15-minute per-student lockout; a password change re-authenticates with the CURRENT password and revokes every existing session.

### Multi-tenancy via slug routes

Each school has a URL slug; all school-scoped pages live under `/school/:slug/...` (portal, student dashboard, admin dashboard, change-pin, settings). Routes are declared in `src/App.tsx`. `SchoolPortal` is the per-school entry point where users choose student vs admin login.

### Privileged operations = Supabase Edge Functions

The frontend uses the anon key with RLS (33 policies); anything needing the service role or a secret is a Deno edge function in `supabase/functions/`:

- `student-auth`, `change-pin`, `student-set-pin` — student auth (via `verify_student_pin` / `verify_student_session`)
- `register-school`, `add-bursar`, `remove-bursar`, `handle-school-request` — school/admin management
- `create-paystack-payment`, `verify-paystack-payment`, `paystack-webhook` — the LIVE payment flow (see below)

Secrets (`SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY`, `RESEND_API_KEY`) are set only as Supabase edge function secrets — never in the repo.

**`verify_jwt = false` is a deliberate, audited list** (`supabase/config.toml`): only the student functions (students hold no Supabase JWT) and `paystack-webhook` (server-to-server). Every one does its own authorization — password, session token, or HMAC signature. Note the anon key is itself a valid JWT, so `verify_jwt = true` proves nothing about *who* is calling; functions that need an identity (`register-school`, `add-bursar`, `remove-bursar`, `handle-school-request`) must also call `auth.getUser()` and check it. Do not add a function to the `verify_jwt = false` list without that reasoning.

The legacy Zendfi flow (`create-zendfi-payment`, `zendfi-webhook`), `student-payment`, and `check-user-exists` were **deleted** in the 2026-08-03 security pass. `student-payment` could write `payments` rows that defaulted to `status = 'success'` with no gateway involved; `check-user-exists` was an unauthenticated email-enumeration oracle with no callers. If they still exist in the hosted project, delete them there too (`supabase functions delete <name>`).

### Paystack payment flow (split settlement)

Each school row (a "branch" — one owner can register many, each with its own bank details) gets a Paystack **subaccount** provisioned lazily on first payment: `create-paystack-payment` resolves the bank code from `schools.bank_name` via Paystack's `/bank` API, creates the subaccount with `schools.account_number`, and caches the code in `schools.settings.paystack_subaccount_code` (JSONB — no schema change). Every transaction is initialized with `subaccount` + a flat `transaction_charge` equal to **1% of the fee amount (the platform's cut)** and `bearer: "subaccount"`. The checkout total is **grossed-up** so the student bears Paystack's processing fee (1.5% + ₦100, waived < ₦2,500, capped ₦2,000) — the gross-up math lives in both `create-paystack-payment/index.ts` and `SchoolStudentDashboard.tsx` and must stay in sync. Net effect: student pays fees + gateway fee; school's bank receives fees − 1%; platform keeps 1%.

Recording is idempotent on `payments.reference` (unique index from the reconcile migration) and happens twice-safe via both `paystack-webhook` (HMAC-SHA512 `x-paystack-signature`) and `verify-paystack-payment` (called by the dashboard when Paystack redirects back with `?reference=`).

**The cached subaccount is invalidated in the database, not in the UI.** `create-paystack-payment` only provisions a subaccount when `settings.paystack_subaccount_code` is absent, so a bank-details change *must* clear it — otherwise every later payment silently settles into the school's OLD bank account. The `guard_school_settlement_settings` trigger (migration 20260803120000) strips the cache whenever `bank_name` or `account_number` changes, and blocks clients from writing those keys at all (only the service role may set them). Don't move this back into page code.

**Both recording paths refuse an underpaid charge**: `create-paystack-payment` puts `expected_total_kobo` in the transaction metadata, and the webhook and redirect-verify both compare it against `data.amount` before crediting any fee. Charges predating that field have nothing to compare and are trusted as before.

`paystack-webhook` **redacts** the event body before writing `payment_events` — Paystack echoes back card BIN/last4/expiry, the payer's email and their IP, none of which we need or want to retain.

### Data model — the LIVE database is the source of truth, not the old migrations

The live DB was rebuilt by hand when the project moved off the Lovable tenant, so it diverges from the pre-2026-07 migrations: it uses **`sessions`/`terms`** (not `academic_sessions`/`academic_terms`), `profiles.id` is the auth user id (no `user_id` column), `students` has extra columns (`is_first_login`, `surname`, `session_id`, …), and there is no `student_fees` table. `src/integrations/supabase/types.ts` was hand-reconciled against the live schema (2026-07-06) — keep it in sync when the schema changes. `supabase/migrations/20260706130000_reconcile_live_schema.sql` documents/repairs the drift (missing `payments` columns, `class_fees` unique index for the upsert, session/term seeding, RLS policies).

Tables: `schools`, `students`, `profiles`, `school_admins`, `school_requests` (bursar invitations), `sessions` → `terms` (academic periods per school), `class_fees` (fee definitions per class+period), `fee_items` (legacy per-student instances), `payments`, `payment_events` (webhook audit log), `notifications`, `student_sessions` + `student_auth_throttle` (service-role only, no RLS policies). Fees and payments are scoped to a session/term — `src/hooks/useAcademicPeriods.ts` and `src/components/AcademicPeriodSelector.tsx` drive that selection. Student fee summaries are computed server-side by the `student-auth` function (class_fees minus payment items); the frontend never queries the `students` table for auth.

### Payment line items are keyed by fee id

`payments.items` entries are `"<fee uuid>|FeeName|amount"`. The legacy `"FeeName|amount"` form still parses and still reconciles by name — those rows are real money and must keep working — but anything new carries the id, because name-keyed matching silently cross-credited two fees sharing a name in the same period (typically a class-specific fee and an `ALL` fee both called "Transport"): paying one marked the other settled and the school lost the difference.

Parsing and per-fee totals live in `src/lib/feeItems.ts`, mirrored for Deno in `supabase/functions/_shared/feeItems.ts`. **The two files must stay identical below their header comments** — `src/lib/feeItems.test.ts` asserts it, because if they drift the amount a student is charged and the amount they're credited stop agreeing. Regenerate the mirror from the source rather than hand-editing both.

### RLS: what is and is not client-readable

Money and credentials are scoped to school members; nothing financial is public:

- `payments`, `fee_items` — SELECT requires `is_school_member(school_id)`. **No INSERT/UPDATE policy at all** — every write goes through a service-role edge function, so a client can never fabricate or alter a payment.
- `payment_events` — RLS on, **no policy**: unreachable from a browser, service-role only, and off the Realtime publication.
- `students`, `school_admins`, `profiles`, `class_fees`, `school_requests` — see 20260707140000 / 20260707120000.
- `schools` and `sessions`/`terms` SELECT stay `using(true)`: the portal shows a school's name before login, and the student dashboard reads periods with the anon key (students hold no JWT). Only low-sensitivity naming data is exposed this way — do not put anything else in those tables.

`payments` and `payment_events` were both `using(true)` until migration 20260803100000, which is how every school's payment history and every raw webhook payload (card BIN/last4, payer email, IP) sat readable by anyone holding the public anon key. If you add a table that touches money, give it a member-scoped SELECT and no client write policy.

### Fee approval workflow (migration 20260707090000)

`class_fees.status` is `pending` or `published`. Owners AND bursars create fees (always as `pending`, enforced by RLS insert policy); only owners publish (RLS update policy: `is_school_owner`) via the admin "Fees" tab. Students only ever see/pay `published` fees — the filter exists in `student-auth`, `create-paystack-payment`, AND legacy `create-zendfi-payment`; any new student-facing read of class_fees must add it too. **Published fees are immutable for the whole session** — a DB trigger (`protect_published_class_fees`) rejects updates/deletes even from the service role; the only allowed transition is pending→published. The Add Fee dialog refetches on open and re-checks statuses server-side before upserting, because a fee published mid-edit would abort the whole upsert batch via the trigger.

### Academic periods are protected against deletion (migration 20260803140000)

A period that has ANY fee or payment attached cannot be deleted by anyone — `payments.session_id/term_id` and `class_fees.session_id/term_id` are foreign keys with `ON DELETE RESTRICT`, which even the service role cannot bypass. Before that migration those columns had no FK at all, and `sessions`/`terms` had a blanket `FOR ALL` policy letting any school MEMBER (a bursar, not just the owner) delete a session: the terms cascaded away and every payment for that period silently pointed at a dead UUID, vanishing from the period-filtered dashboards while the money stayed in the bank.

`sessions`/`terms` policies are now split: SELECT `using(true)` (the student dashboard reads periods with the anon key), INSERT by school member (`useAcademicPeriods` auto-seeds a school's first period on load), UPDATE/DELETE owner-only. No app code path updates or deletes these rows, so the narrower grant costs nothing.

### Custom domains

The frontend origin appears in exactly one server-side-relevant place: `resetPasswordForEmail(redirectTo: ${origin}/account-recovery)` in `OwnerLogin.tsx`. Any new domain MUST be added to Supabase Auth → URL Configuration → Redirect URLs, per project, or password recovery silently fails for users on that domain. Everything else that touches the origin (`portalUrl`, the Paystack `callback_url`) is computed at runtime and follows the domain automatically. The Supabase project URL itself is hardcoded in `client.ts` and is unaffected.

`supabase/config.toml`'s `[auth]` block documents the intended URLs but **cannot be pushed** (`supabase config push` syncs unrelated paid-tier settings and 402s) — keep it in sync by hand and change the real setting in the dashboard.

### Security headers (vercel.json)

`vercel.json` sets CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`. The CSP is deliberately strict — `script-src 'self'` with no `'unsafe-eval'`, verified against the built bundle — so **any new external resource must be added explicitly or it will be blocked at runtime**. `style-src`/`font-src` allow `fonts.googleapis.com`/`fonts.gstatic.com` for the `@import` at the top of `src/index.css`. `frame-ancestors 'none'` is what stops the payment pages being framed for clickjacking.

### Sessions: virtual future sessions

The session dropdown shows real sessions plus 10 upcoming virtual ones (`buildFutureSessions` in useAcademicPeriods, ids `future-<year>`, no DB rows). `isFutureSession` must gate every data query and edit path — virtual ids are not UUIDs and will 22P02 any DB filter they reach. Both dashboards blank all lists and disable Add Fee/Add Student/Upload under a future session.

### Password recovery

OwnerLogin "Forgot password?" → `resetPasswordForEmail(redirectTo: /account-recovery)` → `src/pages/AccountRecovery.tsx` (`updateUser`). Requires the origin's `/account-recovery` URL in Supabase Auth → URL Configuration → Redirect URLs for EACH project (hosted config; `supabase config push` cannot be used — it syncs unrelated paid-tier settings and 402s). `clearAuthState` in supabaseAuthContext exempts `/account-recovery` from its redirect.

### Hardcoded Supabase URL + anon key (intentional)

`src/integrations/supabase/client.ts` hardcodes the project URL and publishable key **on purpose** — see `notes/supabase-env-vars.md`. Do not "fix" this by moving to env vars without being asked; both values are public by design and hardcoding keeps Vercel deploys config-free.

### Error handling / white screens

`ErrorBoundary` wraps the whole app, and `supabaseAuthContext` aggressively clears stale auth state — this was a deliberate fix for blank-screen crashes documented in `WHITESCREENFIX.md`. Preserve the defensive null-guards and the "don't redirect while on `/school/*`" logic when touching auth.

## Staging

`eduledgerng-staging` (project ref `vmqeqwszeekzkvtxkebv`, org "Satyam Shivhare") is a full replica of production: schema via `supabase/migrations/` (baseline + reconcile), all edge functions deployed. **The CLI is deliberately linked to staging** (`supabase/.temp/project-ref`) so `db push` / `functions deploy` hit staging by default — production changes should go through the dashboard SQL editor / explicit `--project-ref ifonivphhfplntzshtsb`. Local dev targets staging via `.env.local` (git-ignored); delete that file to point local dev back at production. Production Vercel builds are unaffected (hardcoded values in `client.ts` are the fallback).

Test data on staging: school "Demo High School" (slug `demo`), owner `owner@demo-staging.test` / `Staging123!`, bursar `bursar@demo-staging.test` / `Staging123!`, student `OCD-1234` / password `Staging123!` (was `Password1` until 2026-08-03 — the new password policy in `supabase/functions/_shared/password.ts` rejects it as too common), JSS1 fees seeded for 2026/2027 Term 1. Staging still needs `PAYSTACK_SECRET_KEY` (test key) set as a function secret before payment flows can be exercised.

The canonical migration chain is `20260706120000_baseline_live_schema.sql` (fresh-project baseline — production already has this state; use `supabase migration repair --status applied 20260706120000` before ever pushing to prod) followed by `20260706130000_reconcile_live_schema.sql` (pending on production), then the dated migrations through `20260803120000`. Pre-2026-07 migrations live in `supabase/migrations-archive/` and must never be applied.

## Known issues

- **The 2026-08-03 security migrations are applied and verified on STAGING, and still PENDING on PRODUCTION.** See `docs/PRODUCTION_DEPLOY.md` for the exact runbook. The six pending files are `20260729120000_payment_notifications.sql` (which was also unapplied on staging until then) plus `20260803100000` … `20260803140000`. **Order is load-bearing:** migrations → functions → frontend. The migrations are backward compatible with the currently-deployed old functions, but between the function deploy and the Vercel deploy **checkout returns an error** (old frontend sends a password, new function wants a session token), so those two steps must land back to back. Also delete the four removed functions from the hosted project — deleting the source files does not remove them from Supabase.
- **Rotate the anon key** if it was ever treated as sensitive — it wasn't secret, but every payment row and raw webhook payload was readable with it until 20260803100000. Assume that data leaked and decide whether affected schools need telling.
- **Existing students keep their current passwords**, which the backfill hashes in place. Any student still on the old shared `"password"` default is still a one-guess takeover until they rotate — after applying the migrations, consider a one-off reset of every student with `must_change_pin = true` so they all get a fresh random temporary password.
- **Assume every student password on production is compromised.** `student-set-pin` used to write the student's chosen password into `students.default_pin` in plaintext, so hashing `pin` alone would have been cosmetic. On staging this affected 16 of 17 students. Migration `20260803130000` nulls those columns and adds a trigger enforcing the invariant, but it cannot un-leak what was already exposed — `students` was anon-readable until 20260707120000. Forcing a rotation of every student password on production is the safe call.
- **Turn on "Secure password change" in Supabase Auth settings** (requires reauthentication for `updateUser({password})`). `ChangePassword.tsx` now re-authenticates client-side, but the dashboard setting is what enforces it at the API.
- **Pending manual steps (as of 2026-07-06)**: the reconcile migration (`supabase/migrations/20260706130000_reconcile_live_schema.sql`) must be run against the live DB via the SQL Editor. The Supabase CLI is not authenticated locally (`supabase login` needed for `db push` / `functions deploy`).
- Two live schools have `slug = NULL` ("My Test School", "My School") and are unreachable via `/school/:slug`.
- `fee_items` is a legacy table with no writer left (`student-payment` was deleted). It is read-only vestige; drop it once you've confirmed no historical reporting depends on it.
- `npm run build` does NOT typecheck. Run `npx tsc -b --noEmit` separately — it is currently clean, keep it that way.
