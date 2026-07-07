# Architecture

EduLedgerNG is a multi-tenant school-fee-management platform for Nigerian schools. It has **no traditional backend server**: a React single-page app in the browser talks *directly* to Supabase (Postgres, RLS, and Deno edge functions), with Paystack for payment collection. This document explains the layers, the trust boundaries, and *why* the system is shaped the way it is. It is the conceptual companion to the reference docs (`02`–`08`).

## Technology stack

| Layer | Technology | Where it runs |
|-------|------------|---------------|
| Frontend | Vite + React 18 + TypeScript, shadcn/ui, Tailwind, React Router, TanStack Query | The user's browser |
| Client data access | `@supabase/supabase-js` with the **anon (publishable) key** | The user's browser |
| Database | Supabase Postgres 17 with Row-Level Security (RLS) | Supabase (managed) |
| Privileged server logic | Supabase Edge Functions (Deno) using the **service-role key** | Supabase (managed) |
| Payments | Paystack (hosted checkout + subaccount split settlement) | External |
| Hosting | Vercel (static SPA + SPA rewrite) | Vercel |

The hardcoded Supabase URL + anon key live in `src/integrations/supabase/client.ts` (with a `VITE_SUPABASE_*` env override used only for local→staging dev). This is intentional — both values are public by design and ship in the JS bundle regardless; see `10-decisions-adr.md` (ADR-001) and `notes/supabase-env-vars.md`.

## The three layers and the trust boundary

```
┌─────────────────────────────────────────────────────────────┐
│  BROWSER (untrusted)                                          │
│  React SPA + supabase-js (anon key, visible in the bundle)   │
│   • UX only: hides irrelevant buttons, shows messages        │
│   • Anyone can bypass the UI and call the DB/functions直接    │
└───────────────┬───────────────────────────┬─────────────────┘
                │ PostgREST / Realtime       │ functions.invoke()
                │ (anon key + user JWT)      │ (user JWT or anon)
                ▼                            ▼
┌───────────────────────────┐   ┌───────────────────────────────┐
│  POSTGRES + RLS           │   │  EDGE FUNCTIONS (Deno)         │
│  Enforcement FLOOR.       │   │  Trusted server logic.         │
│  Every request is         │   │  service-role key → BYPASSES   │
│  filtered by RLS policies │   │  RLS. Does the privileged/     │
│  no matter its origin.    │   │  complex work; verifies the    │
│  (see 03-security-rls)    │   │  caller itself. (see 05)       │
└───────────────────────────┘   └───────────────┬───────────────┘
                                                 │ HTTPS
                                                 ▼
                                        ┌──────────────────┐
                                        │  Paystack        │
                                        │  (see 07)        │
                                        └──────────────────┘
```

**The load-bearing idea: the browser is not trusted.** Because the SPA holds the anon key and talks straight to Postgres, any rule that lives *only* in React can be bypassed by opening the dev console and calling the API directly. Therefore:

- **React** does UX and *convenience* — it hides buttons a role shouldn't see and shows friendly errors. It enforces nothing.
- **Edge functions** are trusted server code. They hold the service-role key (which bypasses RLS), so they must verify the caller themselves. They carry the *logic* that is too complex or too privileged for RLS: PIN verification + lockout, Paystack orchestration, bursar account creation, invitation acceptance.
- **RLS policies** are the enforcement *floor*. They see every request regardless of origin (UI, script, or `curl`) and are the one place authority cannot be bypassed.

The division of responsibility, stated once: **logic lives in code; *authorization* (who may touch what) lives at the data layer.** This is why there are "so many policies" — they are not a substitute for code, they are the security mechanism the direct-DB-access architecture *requires*. See `03-security-rls.md`.

> The bursar security audit (2026-07-07) was entirely about closing gaps where the UI hid a button but no RLS/edge-function check backed it up. See `11-limitations-constraints.md` and ADR-006.

## Multi-tenancy

Each school is one row in `schools` with a URL **slug**. All school-scoped pages live under `/school/:slug/...`. A single admin (Supabase auth user) can own or be a bursar of multiple schools, tracked in `school_admins(school_id, user_id, role)`. "Branches" are simply separate `schools` rows owned by the same admin, each with its own bank account and (therefore) its own Paystack subaccount. RLS scopes every read/write to the caller's schools via `is_school_member()` / `is_school_owner()`.

## Two independent identity systems

There is no single "user" concept. See `04-authentication.md`.

1. **Staff (owner / bursar)** — real Supabase Auth (email + password). Roles in `school_admins.role`.
2. **Students** — *not* Supabase Auth users. They authenticate with `student_id` + a 4-digit PIN, verified **server-side** by the `student-auth` edge function via the `verify_student_pin` RPC (with lockout). The student "session" is app state persisted to `localStorage` under `pity_*` keys, plus the credentials re-sent to edge functions for privileged actions (pay, change PIN).

## Request-flow examples

**Reading the admin dashboard (staff, direct DB):** browser → PostgREST with the owner/bursar JWT → RLS filters rows to the caller's school → React renders. No server code involved; RLS is the only gate.

**Student login (untrusted PIN, server-mediated):** `SchoolPortal` → `functions.invoke("student-auth")` → edge function (service role) runs `verify_student_pin` (checks PIN, applies lockout) → returns the student, their published fees (computed), and payment history → stored in `schoolContext`.

**Paying fees (money, fully server-mediated):** `SchoolStudentDashboard` → `create-paystack-payment` (validates against *published* fees, provisions/looks up the school subaccount, grosses up the fee, initializes a split transaction) → Paystack hosted checkout → redirect back → `verify-paystack-payment` **and** `paystack-webhook` both record idempotently on `payments.reference`. See `07-payments.md`.

**Approving a fee (authority + immutability):** owner clicks Approve → PostgREST UPDATE `status='published'` (RLS `is_school_owner`) → the `protect_published_class_fees` trigger locks the row for the rest of the session. Bursars are blocked by RLS; published rows are immutable even to the service role. See `08-sessions-fees.md`.

## Environments & deployment

Two Supabase projects (production in one org, staging in another), Vercel for the frontend, and a migration/deploy process that is partly manual because of production access constraints. This has real operational consequences — see `09-environments-deployment.md` and `12-operations-runbook.md`.

## Repository map

- `src/pages/` — one component per route (dashboards, portals, auth pages). The live dashboards are `SchoolAdminDashboard.tsx` and `SchoolStudentDashboard.tsx`; `Dashboard.tsx` is the multi-school `/main-dashboard`.
- `src/lib/` — `supabaseAuthContext` (staff auth), `schoolContext` (student session), `generateReceiptPdf`, `utils`.
- `src/hooks/useAcademicPeriods.ts` — sessions/terms + virtual future sessions.
- `src/integrations/supabase/` — client + hand-maintained `types.ts`.
- `supabase/migrations/` — the canonical, applied schema chain. `supabase/migrations-archive/` — abandoned Lovable-era migrations (never re-apply). `supabase/functions/` — edge functions. `supabase/ops/` — one-off operational SQL.
