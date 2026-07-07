# Environments & Deployment

There are two Supabase projects (production and staging) and a Vercel frontend. Deployment is **partly manual** because the production database lives in an organization where the working account has a limited role. This document is the source of truth for *what lives where*, *who can do what*, and *how to ship a change safely*.

## Environments

| | Production | Staging |
|---|---|---|
| Supabase project ref | `ifonivphhfplntzshtsb` | `vmqeqwszeekzkvtxkebv` |
| Supabase org | **Johnawoleke's Org** (not the working account's) | **Satyam Shivhare** (the working account's own org) |
| Region | eu-west-1 | eu-west-1 |
| Frontend URL | `https://eduledgerng.vercel.app` | local dev only (`npm run dev`) |
| Purpose | Live app | Full replica for testing before prod |

**The user-facing production domain is `eduledgerng.vercel.app`.** The auto-generated `eduledgerng-johnawoleke-7622s-projects.vercel.app` is Vercel-protected (302s) and is *not* the domain users hit — this matters for the Supabase Auth redirect allowlist (see Password recovery below).

Staging is a byte-for-byte schema replica built from `supabase/migrations/` and seeded with demo data:
- School "Demo High School" (slug `demo`) + "Ikeja Branch" (slug `demo-ikeja`).
- Owner `owner@demo-staging.test` / `Staging123!`; bursar `bursar@demo-staging.test` / `Staging123!`.
- Student `OCD-1234` / PIN `Password1`; JSS1 fees seeded for 2026/2027 Term 1.

## Access constraints (read this before you get a 403)

The working account (`usemaki.com@gmail.com`, GitHub `learnwithsatyam`) has a **limited role in Johnawoleke's org**. Empirically:

| Action | Works with the account? |
|---|---|
| Deploy edge functions to prod (`supabase functions deploy`) | ✅ yes (uses the CLI access token) |
| Run SQL in the prod dashboard SQL editor | ✅ yes |
| Set prod edge-function secrets (`supabase secrets set`) | ❌ no — needs Owner/Admin (do via dashboard UI or ask John) |
| Create a project in John's org | ❌ no (staging was created in the personal org instead) |
| `supabase db push` to prod | ❌ blocked — needs the **prod DB password** (held by John), which the account does not have |
| Push to GitHub `Johnawoleke/eduledgerng` | ✅ yes (collaborator with write access, via `gh auth login` as `learnwithsatyam`) |

**Consequence:** production DB changes are applied by **pasting SQL into the dashboard SQL editor**, not `supabase db push`. Edge functions and the frontend *can* be deployed directly.

## The migration ledger situation

Production was hand-built and drifted from the migration history (this is the root cause of several surprises: the `verify_student_pin` 500, two rounds of stray permissive RLS policies). As of 2026-07-07 the prod migration ledger (`supabase_migrations.schema_migrations`) has been reconciled — it lists all 6 current migrations plus 14 archived Lovable-era ones — via `supabase/ops/reconcile_prod_migration_ledger.sql`. This means a future `supabase db push` would see everything as applied and run only new migrations **once the prod DB password is available**. Until then, keep pasting SQL.

The CLI in this repo is deliberately **linked to staging** (`supabase/.temp/project-ref` = the staging ref) so a bare `db push` / `functions deploy` can never accidentally hit production. Production always needs an explicit `--project-ref ifonivphhfplntzshtsb`.

## Secrets (edge-function secrets, never in the repo)

Set as Supabase edge-function secrets per project:

- `SUPABASE_SERVICE_ROLE_KEY` — full DB access, bypasses RLS (auto-present).
- `SUPABASE_ANON_KEY` — used by functions to build a caller-scoped client for `getUser()` (auto-present).
- `PAYSTACK_SECRET_KEY` — `sk_test_…` on staging, `sk_live_…` on prod (live requires an activated Paystack business). Test key ↔ Paystack Test-mode webhook; live key ↔ Live-mode webhook.
- `ZENDFI_API_KEY` / `ZENDFI_TEST_KEY`, `ZENDFI_WEBHOOK_SECRET` — legacy Zendfi flow (no longer used by the UI).

## Password recovery redirect allowlist

`resetPasswordForEmail` and `/account-recovery` require the origin's URL to be in **Supabase → Auth → URL Configuration → Redirect URLs** for each project. Production must allowlist `https://eduledgerng.vercel.app/**` (the real user domain — not the long protected one). `supabase config push` cannot be used to set this on the free tier (it tries to sync paid-tier settings and 402s), so it is configured in the dashboard UI.

## Paystack webhook URLs

- Prod: `https://ifonivphhfplntzshtsb.supabase.co/functions/v1/paystack-webhook` (set in Paystack **Live** tab).
- Staging: `https://vmqeqwszeekzkvtxkebv.supabase.co/functions/v1/paystack-webhook` (Paystack **Test** tab).

## Git & attribution

- Repo: `Johnawoleke/eduledgerng` (public). Default branch `main`. Vercel auto-deploys `main` (~2 min).
- Commit identity for the working account: `Satyam Shivhare <mkssshivhare@gmail.com>` (repo-local).
- Commit/PR attribution is intentionally disabled (`~/.claude/settings.json` `attribution.commit/pr = ""`) — no "Co-Authored-By" trailers.

## Standard rollout order (prevents broken windows)

For a change that touches DB + functions + frontend, deploy in this order:

1. **Edge functions → prod** (`supabase functions deploy <names> --project-ref ifonivphhfplntzshtsb`). Additive; safe first.
2. **Frontend → GitHub** (`git push origin main`); wait for Vercel (~2 min). The new frontend can rely on the already-deployed functions.
3. **DB migration** last — paste the migration SQL into the prod SQL editor. Frontend-first avoids a window where the live UI hits a not-yet-migrated schema; functions that use the service role work regardless of migration timing.

Every change is verified on **staging first** with live-token tests (see `12-operations-runbook.md`) before touching production.
