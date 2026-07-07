# Operations Runbook

Practical procedures for building, verifying, and shipping changes. Assumes `npm` (a `bun.lock` exists but bun is not installed). See `09-environments-deployment.md` for the environment/access context these commands operate in.

## Local development

```sh
npm install
npm run dev            # http://localhost:8080
npm run build          # production build (Vite only — does NOT typecheck)
npx tsc -b --noEmit    # typecheck (run this separately; build won't catch type errors)
npm run lint
npm test               # vitest run
npx vitest run src/hooks/useAcademicPeriods.test.ts   # a single test file
```

Local dev points at **staging** via the git-ignored `.env.local` (`VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`). Delete that file to point local dev back at production. Production Vercel builds ignore it (hardcoded values are the fallback).

## The verification philosophy

**Never verify prod by driving prod.** Every change is proven on **staging first** with live-token tests that exercise the actual RLS/edge functions, then rolled out. When verifying an RLS write-block, check the *effect* (did the row actually change?), not the HTTP status — PostgREST returns `204` for an RLS-filtered UPDATE/DELETE (zero rows matched), not `403`. A `204` alone does **not** prove a write succeeded; re-read the row with the service role.

Live-token test pattern (used throughout this project's history): sign in as owner/bursar via `/auth/v1/token`, then make PostgREST/function calls with that JWT and assert on the resulting state read back with the service-role key. See the scratchpad scripts written during the bursar audit for concrete examples.

## Deploying edge functions

```sh
# staging (CLI is linked to staging by default)
npx supabase functions deploy <name> [<name> ...] --project-ref vmqeqwszeekzkvtxkebv

# production (must be explicit)
npx supabase functions deploy <name> [<name> ...] --project-ref ifonivphhfplntzshtsb
```

Deploying all functions: omit the names. `verify_jwt` is read from `supabase/config.toml` at deploy time — functions absent from that file default to `verify_jwt = true` (require a JWT). Student-facing functions that are called with the anon key (`student-auth`, `student-set-pin`, the payment functions) are listed there with `verify_jwt = false`.

## Applying a database migration

**Staging:** `npx supabase db push -p "$STAGING_DB_PASSWORD"` (the staging password was generated at project creation; it lives in the session scratchpad / your own records).

**Production:** paste the migration file's SQL into the Supabase dashboard SQL editor and Run (default `postgres` role — RLS does not apply to DDL). `db push` to prod is blocked until the prod DB password is obtained (see `09`). Migrations are written to be **idempotent** (`if not exists`, `drop policy if exists`, `on conflict do nothing`) so a re-run is safe.

Migration conventions:
- Name `YYYYMMDDHHMMSS_snake_case.sql` in `supabase/migrations/`.
- Additive and idempotent. When tightening RLS, drop **all** policies on the table and recreate the canonical set (prod carries un-named legacy policies — see `11`).
- Put non-migration operational SQL in `supabase/ops/`; put reversal SQL in `supabase/rollback/`. Neither runs via `db push`.

## Standard full-stack rollout (functions → frontend → DB)

1. Verify on staging (push migration + deploy functions there, run live-token tests).
2. `supabase functions deploy … --project-ref ifonivphhfplntzshtsb`.
3. `git push origin main` → wait ~2 min for Vercel; confirm the new bundle is live (fingerprint a distinctive string in `/assets/index-*.js`).
4. Paste the migration SQL into the prod SQL editor.
5. Re-verify prod (read-only / throwaway-record checks with the service role).

Frontend-first-then-DB avoids a window where the live UI hits an un-migrated schema; service-role functions work regardless of migration timing.

## Common tasks

**Add a school owner as a bursar / manage staff:** owners use the Admin dashboard "Add Bursar" dialog (create-account or invite) and the staff list (remove / cancel invite). Behind it: `add-bursar`, `remove-bursar`, `handle-school-request`. See `06-user-workflows.md`.

**Reset a student who is locked out:** the lockout auto-clears after 15 minutes, or an owner can reset the PIN (which also clears counters) from the Students tab, or set `failed_login_attempts=0, locked_until=null` with the service role.

**Rotate the Paystack key / go live:** set `PAYSTACK_SECRET_KEY` (dashboard → Edge Functions → Secrets), and set the matching-mode webhook URL in Paystack. Test and Live are separate.

**Regenerate types after a schema change:** `npx supabase gen types typescript --project-id ifonivphhfplntzshtsb` (or hand-edit `src/integrations/supabase/types.ts` to match the live schema).

## Incident cheat-sheet (from real incidents this project hit)

| Symptom | Likely cause | Fix |
|---|---|---|
| Every student login 500s (`record "v_student" has no field …`) | Prod `verify_student_pin` references a column the table lacks | Align the function + columns (migration `20260707100000`) |
| Admin dashboard goes blank on search | A `payment.reference`/`date` is null and an unguarded `.toLowerCase()`/`new Date()` throws in render | Null-guard the render (already done); backfill/clean the row |
| Anon can still read data you just "locked" | A stray un-named legacy RLS policy survived a `drop policy if exists <name>` | Drop **all** policies on the table, recreate canonical set |
| Paystack "Account details are invalid" | School bank name/number don't match a Paystack bank, or business not activated | Fix bank details in Settings; activate Paystack |
| Password-reset link dead-ends | `/account-recovery` origin not in the Auth redirect allowlist | Add `https://eduledgerng.vercel.app/**` in the dashboard |
