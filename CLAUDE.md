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

**Two e2e suites, and the difference matters.** `npm run test:e2e` (`e2e/`) is
hermetic: every Supabase call is intercepted, so it is fast, deterministic and
CI-safe — and structurally blind to anything involving real data.
`npm run test:staging` (`e2e-staging/`) runs the same app against the STAGING
project with no mocking. It exists because six bugs shipped past the hermetic
suite during the ledger work and four were only visible against a real backend:
a paid-total guard that read legacy payment rows as unpaid, a `setState` never
called so a section rendered empty, a pay button gated on the wrong total so a
student with only older debt could not reach checkout, and two labels that
contradicted the numbers beside them. It needs staging up, so it is deliberately
NOT in CI — run it before a release or when touching either dashboard. It asserts
only what is displayed and never commits a rollover, changes a class, or takes a
payment, so the dataset stays reusable.

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

### Payment gateway: Paystack

**Paystack is the only gateway.** Squad (HabariPay) was routed here from
2026-08-06 and removed on 2026-08-17 without ever having settled a payment — no
school completed sub-merchant provisioning, so no historical row depends on it.
The pluggable layer it introduced was kept, because it is what makes adding
Paystack for Education a rate constant plus a threshold rather than a rewrite.

Three pieces:

- `src/lib/gatewayMoney.ts` (mirrored to `supabase/functions/_shared/gatewayMoney.ts`, sync asserted by `gatewayMoney.test.ts`) — rates, the gross-up, and `selectGateway()`. This is the LIVE checkout maths. Regenerate the mirror from the source rather than editing both. Do not confuse it with `src/lib/gatewayFees.ts`, which is the modelling library behind `/gateway-lab` and touches no real payment — that one still models Squad and other providers on purpose, for comparison.
- `supabase/functions/_shared/gateways.ts` — the provider adapter (initialize, verify, webhook signature, webhook parse, subaccount creation) behind a common `Gateway` interface. Backend only; it reads secrets. `_shared/bankNames.ts` holds the bank-name matcher, split out so it stays Deno-free and unit-testable.
- `supabase/functions/_shared/recordPayment.ts` — settling a payment, in ONE place. The webhook and the redirect-verify both call it, so the underpayment guard and the item encoding cannot drift apart.

Functions: `create-payment`, `verify-payment`, `paystack-webhook`. `payments.gateway` records which provider took each row (migration 20260806100000); it is always `paystack` now, and the column stays so a second gateway needs no migration.

**Money model.** The school receives the EXACT fee it set. The platform's 1% and Paystack's charge are both added on top and borne by the parent:

```
base            = the fee the school set
platform_fee    = 1% of base                    -> platform's Paystack account
total charged   = grossUp(base + platform_fee)  -> parent pays this
school receives = base + platform_fee - platform_fee = base
```

The 1% is collected inline by the adapter as `transaction_charge` with `bearer: "subaccount"`, so it lands in the platform account rather than the school's. Each school gets a Paystack **subaccount** provisioned lazily on first payment: `create-payment` resolves the bank code from `schools.bank_name` via Paystack's `/bank` API (paginated, following the cursor) and caches it in `schools.settings.paystack_subaccount_code`.

**Rate: Paystack standard**, 1.5% + ₦100, the ₦100 waived under ₦2,500, capped ₦2,000. If the **Education** plan (0.7% capped ₦1,500) is approved, add it as a second `GatewayPricing` and give `selectGateway()` a threshold. Do NOT simply lower the numbers in `PAYSTACK` — Paystack deducts whatever your account is actually on, so pricing against an unapproved rate makes every school short on every payment.

**The gross-up uses the DEAREST channel a gateway offers** (`gatewayFeeKobo` takes a max). The parent picks card/transfer at Paystack's own checkout, after we have fixed the amount — pricing on anything but the worst case would let a card payment under-settle the school. A cheaper channel just leaves a small surplus, which settles to the school.

**`verify-payment` only marks an attempt failed when the gateway says it is terminally over** (`isTerminalFailure` in `gateways.ts`). A `pending` verify — routine for a bank transfer the payer has just authorised, since the dashboard verifies the instant checkout redirects back — must leave the row alone for the webhook. Writing it off meant that if the webhook was then missed, the money stayed collected while `create-payment` stopped counting the row as settled and asked the student to pay again.

Secret: `PAYSTACK_SECRET_KEY` (required — used for checkout, verification, webhook signatures AND the `/bank` lookup).

Recording is idempotent on `payments.reference` (unique index from the reconcile migration) and happens twice-safe via both `paystack-webhook` (HMAC-SHA512 `x-paystack-signature`) and `verify-paystack-payment` (called by the dashboard when Paystack redirects back with `?reference=`).

**The cached subaccount is invalidated in the database, not in the UI.** `create-paystack-payment` only provisions a subaccount when `settings.paystack_subaccount_code` is absent, so a bank-details change *must* clear it — otherwise every later payment silently settles into the school's OLD bank account. The `guard_school_settlement_settings` trigger (migration 20260803120000) strips the cache whenever `bank_name` or `account_number` changes, and blocks clients from writing those keys at all (only the service role may set them). Don't move this back into page code.

**Both recording paths refuse an underpaid charge**: `create-paystack-payment` puts `expected_total_kobo` in the transaction metadata, and the webhook and redirect-verify both compare it against `data.amount` before crediting any fee. Charges predating that field have nothing to compare and are trusted as before.

`paystack-webhook` **redacts** the event body before writing `payment_events` — Paystack echoes back card BIN/last4/expiry, the payer's email and their IP, none of which we need or want to retain.

### Data model — the LIVE database is the source of truth, not the old migrations

The live DB was rebuilt by hand when the project moved off the Lovable tenant, so it diverges from the pre-2026-07 migrations: it uses **`sessions`/`terms`** (not `academic_sessions`/`academic_terms`), `profiles.id` is the auth user id (no `user_id` column), `students` has extra columns (`is_first_login`, `surname`, `session_id`, …), and there is no `student_fees` table. `src/integrations/supabase/types.ts` was hand-reconciled against the live schema (2026-07-06) — keep it in sync when the schema changes. `supabase/migrations/20260706130000_reconcile_live_schema.sql` documents/repairs the drift (missing `payments` columns, `class_fees` unique index for the upsert, session/term seeding, RLS policies).

**Production carried a constraint that made multi-session terms impossible.**
`unique_term_name_per_school UNIQUE (name, school_id)` was hand-added during the
Lovable move and exists in neither this repo nor staging. A term belongs to a
session and every session has a Term 1, so from a school's SECOND session onward
its terms could not be created — which is why 21 of 52 production sessions had
none, and a session with no terms can never hold a fee (`class_fees.term_id`).
Migration 20260819120000 replaces it with `terms_session_name_key (session_id,
name)`, which is what the model always meant. If you find another constraint on
the live DB that is not in `supabase/migrations/`, assume the same origin and
check it against the model before working around it.

Tables: `schools`, `students`, `profiles`, `school_admins`, `school_requests` (bursar invitations), `sessions` → `terms` (academic periods per school), `class_fees` (fee definitions per class+period), `fee_items` (legacy per-student instances), `payments`, `payment_events` (webhook audit log), `notifications`, `student_sessions` + `student_auth_throttle` (service-role only, no RLS policies). Fees and payments are scoped to a session/term — `src/hooks/useAcademicPeriods.ts` and `src/components/AcademicPeriodSelector.tsx` drive that selection. Student fee summaries are computed server-side by the `student-auth` function (class_fees minus payment items); the frontend never queries the `students` table for auth.

### Balances come from the fee LEDGER, not from a formula (migration 20260818120000)

`student_charges` records what a student was actually charged: one row per
(student, class_fee), written by trigger when the fee is published, carrying the
amount and the class as at that moment. `student_enrolments` records which class
a student was in per session, one row per (student, session).

Before this, a balance was recomputed on every read as *published `class_fees`
matched against the student's CURRENT class, for the selected period*. The past
was therefore re-derived from today's data, which is why there was no promotion
feature and why one could not safely be added: changing a class silently
re-evaluated last year's debt against this year's fee schedule.

Rules that must hold:

- **Never reintroduce a balance computed by matching `class_target` against
  `students.class`.** Read `student_charges`. The three writers are triggers —
  `charge_students_on_fee_publish`, `charge_student_on_enrolment`,
  `enrol_student_on_create` — and they exist as triggers because publishing a
  fee is a client-side UPDATE that must not be bypassable.
- **How much is paid is summed across ALL periods, matched by fee id.**
  `student-auth` and `SchoolAdminDashboard` both do this. Period-filtering that
  lookup is what made a payment against an old term appear to vanish. The
  period-scoped list is only for the history *display*.
- **`create-payment` takes `session_id`/`term_id` from the CHARGE**, not from the
  request body, so settling last term's debt lands on last term. When one
  payment spans periods it falls back to where it was initiated; per-fee credit
  is unaffected either way because reconciliation matches on fee id.
- RLS mirrors `payments`: member SELECT, **no client write policy at all**.
  `Insert`/`Update` are typed `never` in `types.ts` to say so.
- Charge generation is idempotent via `unique (student_id, class_fee_id)` plus
  `on conflict do nothing`. Keep it that way.

Promotion (not yet built) INSERTS next-session enrolments and marks the old ones
`promoted`/`graduated`. It never updates a class in place, so history cannot be
rewritten.

### Arrears and rollover (Stage 2/3 on top of the ledger)

- `student-auth` returns `feeItems` for the selected period AND `arrears` — the
  unpaid remainder of charges in every OTHER period, each labelled with the
  session/term it came from. Arrears are payable from the current screen because
  `create-payment` takes the period from the charge.
- `promote-session` has three modes: `preview` proposes a default outcome per
  student and changes nothing; `commit` applies **the decisions it is given**;
  `undo` reverses one committed rollover by its batch id.
- **`only_class` narrows a run to one class.** School owners think in classes,
  not sessions: open Primary 3, move Primary 3 up. The whole-school run is the
  same code with the filter off.
- **Commit does not recompute.** The school edits the preview and sends back a
  decision per student, matching how mature SIS store a per-student next grade
  that is defaulted then overridden. Computing at commit time is what made
  "everyone moves up" the only expressible outcome.
- **Five outcomes**, because a Nigerian session has more than one: `promote`,
  `on_trial` (the 40-49% promotion-exam case — advances on probation),
  `repeat`, `graduate`, `archive`. The outcome is stamped on the enrolment being
  LEFT (`promoted` / `promoted_on_trial` / `repeated` / `graduated` /
  `archived`); a newly created enrolment is always `active`.
- **`archive` is not `repeat`, and the difference is money.** A repeater is
  still in school and still gets charged next session; an archived pupil leaves
  the active roster and is charged nothing (the charge triggers skip
  `students.status = 'archived'`). Both are reversible by undo.

### Moving one class at a time cannot double-promote (`src/lib/rollover.ts`)

Move Nursery 1 up, then move Nursery 2 up. If the pupils to move are chosen by
their CURRENT class, the ones you just moved get swept along a second time and
land in Nursery 3 — a year ahead, silently, and only noticed when a parent asks.
The roster shows them in Nursery 2 the moment they move, so nothing on screen
warns you.

The rule that makes it impossible: **a move reads the enrolment in the session
being LEFT, never `students.class`.** `students.class` is updated by a move, so
filtering on it IS the cascade; the enrolment row keeps the class the pupil
actually spent the session in, and stops being `active` the moment they move, so
a moved pupil fails the filter twice over.

`movingEnrolmentFilter` is the single definition of that filter, mirrored for
Deno at `supabase/functions/_shared/rollover.ts` (identical below the headers,
asserted by `rollover.test.ts`). `promote-session` builds its query from it via
`.match()`, and the test drives the same filter through a two-step Nursery 1 → 2
→ 3 sequence. **Never add a key to that filter that is not a column of
`student_enrolments`.**

The confusing case — a class now made entirely of pupils promoted into it — is a
refusal with an explanation, not a silent no-op: doing nothing quietly is what
makes the button look broken.
- **The ladder is `NIGERIAN_CLASSES` and its ORDER is the promotion path.** It
  runs `Nursery 1, Nursery 2` → `Primary 1-6` → `JSS1-3` → `SSS1-3`.
  `CLASS_GROUPS` bands the same list into the four names a school says out loud,
  derived from the ladder so a class cannot be promotable but invisible. A KG
  band was added and removed on 2026-08-23 — the launch schools do not run a KG
  year, and an unused rung is one more class a roster upload can be rejected
  against. Adding a rung is a real decision, not a cosmetic one: it changes
  where every pupil below it is promoted to.
- **The roster lists EVERY class, including empty ones.** It filtered to classes
  with a head count to keep the row short; that cost a new school the ability to
  see the classes it has not set up yet, which is what the list is for on first
  login. Empty classes are muted but present and clickable.
- **The final class is DECLARED by the school** (`schools.settings.final_class`),
  never inferred. Inferring it from the roster graduates the wrong people
  whenever the top class is empty — a through school with no SSS3 students this
  year would graduate its SSS2s, and a new school whose only intake is Primary 1
  would graduate its entire roll. `highestClassInUse()` only seeds a suggestion
  the school confirms; both failures are pinned by tests in `classes.test.ts`.
- **Undo** is the substitute for the snapshot-before-rollover that standard SIS
  practice assumes and a shared database cannot offer. Every enrolment a
  rollover creates OR stamps carries its `rollover_batch`; undo deletes the
  created ones and restores the stamped ones. It must cover both — capturing
  only created rows left graduates, who get no new enrolment, permanently marked
  as having left. Refused once anything has been paid toward the new session.
- `sessions.is_current` moves only when explicitly asked (`make_current`).
  Rolling over in June must not declare a year that has not started current.
- Graduates get `students.status = 'graduated'` and leave the active roster;
  their record and history are untouched.
- `set-student-class` is refused once anything has been paid for that session:
  swapping the charges would orphan a real payment.
- **Say it in plain words.** "Owing this term", "from earlier terms", "Total
  owing", "Who Owes" — never "arrears", "balance" or "outstanding". And only
  claim "this term" when a term is actually selected; with none chosen the
  figure already spans every term.

### Payment line items are keyed by fee id

`payments.items` entries are `"<fee uuid>|FeeName|amount"`. The legacy `"FeeName|amount"` form still parses and still reconciles by name — those rows are real money and must keep working — but anything new carries the id, because name-keyed matching silently cross-credited two fees sharing a name in the same period (typically a class-specific fee and an `ALL` fee both called "Transport"): paying one marked the other settled and the school lost the difference.

Parsing and per-fee totals live in `src/lib/feeItems.ts`, mirrored for Deno in `supabase/functions/_shared/feeItems.ts`. **The two files must stay identical below their header comments** — `src/lib/feeItems.test.ts` asserts it, because if they drift the amount a student is charged and the amount they're credited stop agreeing. Regenerate the mirror from the source rather than hand-editing both.

### RPC EXECUTE grants are part of the security model (migration 20260803150000)

RLS is not the only gate. Postgres grants EXECUTE on new functions to PUBLIC by default and PostgREST publishes everything in `public` as `/rest/v1/rpc/<name>`, so a `SECURITY DEFINER` function is reachable from any browser holding the anon key unless you revoke it. Before that migration this meant **anyone could POST to `create_student_session` and mint a valid session token for any student id, with no password at all** — and `verify_student_pin` was an unlimited password-guessing oracle that bypassed the per-IP throttle entirely (it had been anon-callable since the baseline schema).

`verify_student_pin`, `verify_student_session`, `create_student_session`, `revoke_student_sessions`, `student_auth_throttle_check/reset`, every trigger function, and `is_bcrypt_hash` are now **service_role only**. `is_school_member` / `is_school_owner` MUST stay executable by `anon` and `authenticated` — they are evaluated inside RLS policy expressions as the querying role, and revoking them locks the app out of its own data.

Default privileges in `public` now revoke EXECUTE from `public`/`anon`/`authenticated`, so a new function is private unless it grants itself out. **When you add a function, decide explicitly which roles may call it**, and remember `service_role` needs a grant too — it bypasses RLS, not GRANTs.

### RLS: what is and is not client-readable

Money and credentials are scoped to school members; nothing financial is public:

- `payments`, `fee_items` — SELECT requires `is_school_member(school_id)`. **No INSERT/UPDATE policy at all** — every write goes through a service-role edge function, so a client can never fabricate or alter a payment.
- `payment_events` — RLS on, **no policy**: unreachable from a browser, service-role only, and off the Realtime publication.
- `class_fees` — SELECT requires `is_school_member`. It was `status = 'published' or is_school_member` until 20260803160000, which leaked every school's fee schedule and pricing to anyone with the anon key. Students never read this table from the browser; `student-auth` computes their fee summaries server-side.
- `students`, `school_admins`, `profiles`, `school_requests` — see 20260707140000 / 20260707120000.
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

- ~~The 2026-08-03 security migrations are still PENDING on PRODUCTION.~~ **Applied, verified against production 2026-08-16.** Probed with the public anon key: `payments`, `payment_events`, `class_fees`, `students`, `school_admins` and `profiles` all return zero rows; `student_sessions` and `student_auth_throttle` exist; `verify_student_pin`, `create_student_session` and `verify_student_session` all return `42501 permission denied`; `is_school_member`/`is_school_owner` are still callable, as they must be. `payments.gateway` and `payments.expected_total_kobo` both exist, so `20260806100000` and `20260806110000` are applied too. All 13 current edge functions are deployed on prod and staging, and the four deleted ones (`student-payment`, `check-user-exists`, `create-zendfi-payment`, `zendfi-webhook`) return 404 on both. `docs/PRODUCTION_DEPLOY.md` remains the runbook for the next such deploy; **order is load-bearing** there: migrations → functions → frontend.
- **Supabase Auth Site URL on production points at a Vercel deployment URL**, which sits behind Vercel Deployment Protection. Supabase silently replaces a `redirectTo` that is not on the allow-list with Site URL, so password recovery mails a link to a Vercel SSO page. `supabase/config.toml` now documents the intended values (`https://www.eduledgerng.com` plus both hosts' `/account-recovery`), but config cannot be pushed — **set it in the dashboard** under Authentication → URL Configuration, per project. Note the apex 308-redirects to www, so `window.location.origin` is the www host.
- **Rotate the anon key** if it was ever treated as sensitive — it wasn't secret, but every payment row and raw webhook payload was readable with it until 20260803100000. Assume that data leaked and decide whether affected schools need telling.
- **Existing students keep their current passwords**, which the backfill hashes in place. Any student still on the old shared `"password"` default is still a one-guess takeover until they rotate — after applying the migrations, consider a one-off reset of every student with `must_change_pin = true` so they all get a fresh random temporary password.
- **Assume every student password on production is compromised.** `student-set-pin` used to write the student's chosen password into `students.default_pin` in plaintext, so hashing `pin` alone would have been cosmetic. On staging this affected 16 of 17 students. Migration `20260803130000` nulls those columns and adds a trigger enforcing the invariant, but it cannot un-leak what was already exposed — `students` was anon-readable until 20260707120000. Forcing a rotation of every student password on production is the safe call.
- **Turn on "Secure password change" in Supabase Auth settings** (requires reauthentication for `updateUser({password})`). `ChangePassword.tsx` now re-authenticates client-side, but the dashboard setting is what enforces it at the API.
- **Pending manual steps (as of 2026-07-06)**: the reconcile migration (`supabase/migrations/20260706130000_reconcile_live_schema.sql`) must be run against the live DB via the SQL Editor. The Supabase CLI is not authenticated locally (`supabase login` needed for `db push` / `functions deploy`).
- Two live schools have `slug = NULL` ("My Test School", "My School") and are unreachable via `/school/:slug`.
- `fee_items` is a legacy table with no writer left (`student-payment` was deleted). It is read-only vestige; drop it once you've confirmed no historical reporting depends on it.
- `npm run build` does NOT typecheck. Run `npx tsc -b --noEmit` separately — it is currently clean, keep it that way.
