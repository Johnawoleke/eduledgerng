# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

EduLedgerNG — a multi-tenant school fee management app for Nigerian schools. School owners register schools, manage students/fees per academic session and term, and collect payments; students log in with a student ID + 4-digit PIN to view balances and pay via Zendfi. Originally scaffolded by Lovable (Vite + React 18 + TypeScript + shadcn/ui + Tailwind), backed by Supabase, deployed on Vercel.

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

2. **Students** do NOT use Supabase auth. They log in with `student_id` + 4-digit PIN, validated server-side by the `student-auth` edge function (with lockout after failed attempts). The resulting session (student, fees, payments, credentials) is held in `src/lib/schoolContext.tsx` and persisted to localStorage under `pity_*` keys. Subsequent privileged student actions (change PIN, pay) re-send the credentials to edge functions.

### Multi-tenancy via slug routes

Each school has a URL slug; all school-scoped pages live under `/school/:slug/...` (portal, student dashboard, admin dashboard, change-pin, settings). Routes are declared in `src/App.tsx`. `SchoolPortal` is the per-school entry point where users choose student vs admin login.

### Privileged operations = Supabase Edge Functions

The frontend uses the anon key with RLS (33 policies); anything needing the service role or a secret is a Deno edge function in `supabase/functions/`:

- `student-auth`, `change-pin` — PIN-based student auth (via the `verify_student_pin` RPC)
- `register-school`, `add-bursar`, `check-user-exists`, `handle-school-request` — school/admin management
- `create-paystack-payment`, `verify-paystack-payment`, `paystack-webhook` — the LIVE payment flow (see below)
- `create-zendfi-payment`, `zendfi-webhook`, `student-payment` — legacy Zendfi/manual flow, no longer offered in the UI

Secrets (`SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY`, `ZENDFI_TEST_KEY`, `ZENDFI_WEBHOOK_SECRET`) are set only as Supabase edge function secrets — never in the repo.

### Paystack payment flow (split settlement)

Each school row (a "branch" — one owner can register many, each with its own bank details) gets a Paystack **subaccount** provisioned lazily on first payment: `create-paystack-payment` resolves the bank code from `schools.bank_name` via Paystack's `/bank` API, creates the subaccount with `schools.account_number`, and caches the code in `schools.settings.paystack_subaccount_code` (JSONB — no schema change). Every transaction is initialized with `subaccount` + a flat `transaction_charge` equal to **1% of the fee amount (the platform's cut)** and `bearer: "subaccount"`. The checkout total is **grossed-up** so the student bears Paystack's processing fee (1.5% + ₦100, waived < ₦2,500, capped ₦2,000) — the gross-up math lives in both `create-paystack-payment/index.ts` and `SchoolStudentDashboard.tsx` and must stay in sync. Net effect: student pays fees + gateway fee; school's bank receives fees − 1%; platform keeps 1%.

Recording is idempotent on `payments.reference` (unique index from the reconcile migration) and happens twice-safe via both `paystack-webhook` (HMAC-SHA512 `x-paystack-signature`) and `verify-paystack-payment` (called by the dashboard when Paystack redirects back with `?reference=`).

### Data model — the LIVE database is the source of truth, not the old migrations

The live DB was rebuilt by hand when the project moved off the Lovable tenant, so it diverges from the pre-2026-07 migrations: it uses **`sessions`/`terms`** (not `academic_sessions`/`academic_terms`), `profiles.id` is the auth user id (no `user_id` column), `students` has extra columns (`is_first_login`, `surname`, `session_id`, …), and there is no `student_fees` table. `src/integrations/supabase/types.ts` was hand-reconciled against the live schema (2026-07-06) — keep it in sync when the schema changes. `supabase/migrations/20260706130000_reconcile_live_schema.sql` documents/repairs the drift (missing `payments` columns, `class_fees` unique index for the upsert, session/term seeding, RLS policies).

Tables: `schools`, `students`, `profiles`, `school_admins`, `school_requests` (bursar invitations), `sessions` → `terms` (academic periods per school), `class_fees` (fee definitions per class+period), `fee_items` (legacy per-student instances), `payments`, `payment_events` (webhook audit log). Fees and payments are scoped to a session/term — `src/hooks/useAcademicPeriods.ts` and `src/components/AcademicPeriodSelector.tsx` drive that selection. Student fee summaries are computed server-side by the `student-auth` function (class_fees minus payment items); the frontend never queries the `students` table for auth.

### Fee approval workflow (migration 20260707090000)

`class_fees.status` is `pending` or `published`. Owners AND bursars create fees (always as `pending`, enforced by RLS insert policy); only owners publish (RLS update policy: `is_school_owner`) via the admin "Fees" tab. Students only ever see/pay `published` fees — the filter exists in `student-auth`, `create-paystack-payment`, AND legacy `create-zendfi-payment`; any new student-facing read of class_fees must add it too. **Published fees are immutable for the whole session** — a DB trigger (`protect_published_class_fees`) rejects updates/deletes even from the service role; the only allowed transition is pending→published. The Add Fee dialog refetches on open and re-checks statuses server-side before upserting, because a fee published mid-edit would abort the whole upsert batch via the trigger.

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

Test data on staging: school "Demo High School" (slug `demo`), owner `owner@demo-staging.test` / `Staging123!`, bursar `bursar@demo-staging.test` / `Staging123!`, student `OCD-1234` / PIN `Password1`, JSS1 fees seeded for 2026/2027 Term 1. Staging still needs `PAYSTACK_SECRET_KEY` (test key) set as a function secret before payment flows can be exercised.

The canonical migration chain is `20260706120000_baseline_live_schema.sql` (fresh-project baseline — production already has this state; use `supabase migration repair --status applied 20260706120000` before ever pushing to prod) followed by `20260706130000_reconcile_live_schema.sql` (pending on production). Pre-2026-07 migrations live in `supabase/migrations-archive/` and must never be applied.

## Known issues

- **Pending manual steps (as of 2026-07-06)**: the reconcile migration (`supabase/migrations/20260706130000_reconcile_live_schema.sql`) must be run against the live DB via the SQL Editor, and the edited edge functions (`register-school`, `change-pin`, `add-bursar`, `check-user-exists`) redeployed. The Supabase CLI is not authenticated locally (`supabase login` needed for `db push` / `functions deploy`).
- Two live schools have `slug = NULL` ("My Test School", "My School") and are unreachable via `/school/:slug`.
- Security debt: `students` (including plaintext `pin`) and `school_admins` are readable with the anon key; `ResetPassword.tsx` updates `students` directly from the browser; `add-bursar` doesn't verify the caller owns the school. Tightening these requires moving the reset-password flow into an edge function first.
- `fee_items` + `supabase/functions/student-payment` are a legacy pair — nothing in the UI calls `student-payment`; the live flow is `create-zendfi-payment` → `zendfi-webhook`.
