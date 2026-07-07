# EduLedgerNG — System Documentation

Comprehensive reference for EduLedgerNG, a multi-tenant school-fee-management platform for Nigerian schools. Schools register, manage students and fees per academic session/term, and collect payments via Paystack; students log in with an ID + PIN to view balances and pay. Built with Vite + React 18 + TypeScript on the frontend, Supabase (Postgres + RLS + Deno edge functions) as the backend, deployed on Vercel.

> **The one thing to internalize first:** there is no traditional backend server. The React app in the browser talks *directly* to the database with a public key, so **the UI enforces nothing** — all authorization lives in Row-Level Security policies and edge-function caller checks. Read `01-architecture.md` before anything else.

## How to read these docs

Start with `01-architecture.md`, then read by need:

| Doc | What it covers | Read it when… |
|---|---|---|
| [`01-architecture.md`](01-architecture.md) | The three-layer model, trust boundaries, tech stack, request flows, multi-tenancy | Always first |
| [`02-data-model.md`](02-data-model.md) | Every table, column, key, trigger, enum; the schema-drift history | Touching the database |
| [`03-security-rls.md`](03-security-rls.md) | The RLS policy matrix per table, the enforcement-floor principle, PIN lockout, residual debt | Changing permissions or adding a table |
| [`04-authentication.md`](04-authentication.md) | The two auth systems (staff Supabase auth vs student PIN), roles, password flows | Anything login/session/role related |
| [`05-edge-functions.md`](05-edge-functions.md) | Reference for all edge functions: params, auth, side-effects, live vs legacy | Calling or changing a function |
| [`06-user-workflows.md`](06-user-workflows.md) | Step-by-step end-to-end flows (registration, bursar, student, fees, payment) | Understanding how a feature works |
| [`07-payments.md`](07-payments.md) | Paystack subaccounts, the split, the gross-up math, webhooks, idempotency | Anything money-related |
| [`08-sessions-fees.md`](08-sessions-fees.md) | Academic periods, virtual future sessions, the fee-approval state machine + lock | Sessions/terms or fee logic |
| [`09-environments-deployment.md`](09-environments-deployment.md) | Prod/staging, org ownership & access limits, migration ledger, rollout order, secrets | Deploying or debugging a 403 |
| [`10-decisions-adr.md`](10-decisions-adr.md) | Trade-off decisions (why it's built this way), newest building on oldest | Questioning "why is it like this?" |
| [`11-limitations-constraints.md`](11-limitations-constraints.md) | Assumptions, known issues, security debt, data-quality problems, gotchas | Before assuming something works |
| [`12-operations-runbook.md`](12-operations-runbook.md) | Build/verify/deploy commands, migration procedure, incident cheat-sheet | Doing operational work |

`CLAUDE.md` at the repo root is the condensed orientation for AI assistants; these docs are the expanded human-facing reference.

## 60-second system overview

- **Who uses it:** *owners* (register schools, publish fees, manage staff, control the bank account), *bursars* (data-entry staff — add students, propose fees), and *students* (view/pay fees). Roles live in `school_admins.role`; students aren't auth users at all.
- **The money flow:** a student selects *published* fees → a Paystack hosted checkout → the money settles **directly into that school's bank account** via a per-school Paystack subaccount, minus a flat **1%** platform cut; the student pays the gateway fee on top. Recording is idempotent via both a signed webhook and a redirect-time verify.
- **The integrity rules:** fees start *pending* and only an **owner** can publish them; once published they're **locked for the whole session** (DB trigger). Students are **archived, never deleted**. Future sessions are **virtual** (planning-only, non-editable).
- **The security model:** every permission is enforced in **RLS / edge functions**, because the browser is untrusted. The UI only hides buttons.
- **The operational reality:** production is a hand-built Supabase project that drifted from the migrations; it lives in an org where the working account has limited rights, so prod DB changes are applied by pasting SQL, and everything is proven on a staging replica first.

## Document status

Authored 2026-07-07 against the live codebase and the production/staging databases. The reference docs (`02`–`08`) were generated from the actual code and reviewed for accuracy; the cross-cutting docs (`01`, `09`–`12`) capture architecture reasoning and decisions/history. Keep them updated alongside code changes — especially after schema changes (`02`, `03`) and new decisions (`10`).
