# Limitations, Constraints & Known Issues

An honest register of what the system assumes, where it is fragile, and what debt remains. Grouped by severity. Cross-references point at the deeper docs.

## Core assumptions the system makes

- **The browser is untrusted; RLS/edge functions are the only real enforcement.** Any change must add authorization at the data layer, never only in React. (`01-architecture.md`, ADR-006)
- **The live database is the source of truth, not the migration files.** Production was hand-built and drifted. Regenerate/verify `types.ts` against the live schema after any schema change. (ADR-004)
- **One admin account can own/serve many schools; "branches" are just separate `schools` rows** owned by the same admin, each with its own bank account → its own Paystack subaccount.
- **Students are not auth users**; they are identified by `student_id` + PIN and hold no JWT, so all student writes must be service-role-mediated. (ADR-003, ADR-008)
- **Money settles per school via Paystack subaccounts**; the platform's revenue model is a flat **1% of fees**. (ADR-011)

## Security debt (tracked)

| Item | Status | Detail |
|---|---|---|
| **Plaintext student PINs** | Open, mitigated | `students.pin` is compared/stored in plaintext. Exposure is closed (SELECT is member-only; anon can no longer read PINs) and brute force is limited (5-strike/15-min lockout), but a school owner/bursar or a DB compromise can still read PINs. Hashing is the follow-up. (ADR-007) |
| **`handle-school-request` relies partly on UUID secrecy** | Improved | It now verifies the caller is the invitee, but request UUIDs are the primary unguessable token. Acceptable, noted. (`05-edge-functions.md`) |
| **Removed bursar's JWT** | Mitigated | `remove-bursar` calls `auth.admin.signOut(user, "global")` to revoke sessions, and RLS re-evaluates per request so access ends immediately regardless — but a cached JWT is technically valid until expiry for non-RLS operations. |
| **Profiles email visibility** | Scoped | Emails are readable by the owner of a school the person belongs to / is invited to (for the staff list), and by the person themselves — not by anon. |
| **Archived students can still log in** | Open bug | `verify_student_pin` excludes only `status = 'inactive'` (`coalesce(s.status,'active') <> 'inactive'`), not `'archived'`. Since ADR-010 archives with `status='archived'`, an archived student is hidden from the roster but can **still authenticate and view their dashboard**. Fix: also exclude `'archived'` in the RPC (a one-line migration + redeploy). Surfaced by the documentation audit 2026-07-07. |
| **`register-school` logs the plaintext password** | Open | `register-school/index.ts` `console.log`s the raw request body, which includes the new user's password, into function logs. Fix: stop logging the body, or redact `password`. |

## Operational constraints

- **Production DB changes are applied by pasting SQL into the dashboard editor**, not `supabase db push`, because the working account lacks the prod DB password (held by John) and Owner/Admin role in his org. Secrets likewise must be set via the dashboard UI or by John. (`09-environments-deployment.md`)
- **The Supabase free tier** means no automated DB backups (rollback scripts under `supabase/rollback/` are the undo mechanism), no preview branching, and `supabase config push` 402s (auth redirect URLs must be set in the dashboard).
- **No Docker locally** → no local Supabase stack; staging (a second Supabase project) is used instead.
- **Migration ledger drift**: prod's ledger was reconciled (2026-07-07) but its recorded history doesn't perfectly match the live schema (the archived migrations are marked applied though the live schema differs). Harmless for `db push`, but don't trust the ledger as a schema description.

## Data-quality issues on production

- **Two schools have `slug = NULL`** ("My Test School", "My School") → unreachable via `/school/:slug`.
- **Seven schools have no bank details** → their students get a clear "add bank details in Settings" error at Paystack checkout (correct behavior, not a bug).
- **School "qwert" has ~11 stray `sessions` rows** from an old session-creation bug → cluttered session dropdown for that school only. (Motivated ADR-009.)
- **One legacy `payments` row** (student "Ade Ola Emma") has null `reference`/`date`/`method` — a pre-reconcile artifact. It renders as "—" with no receipt and still counts toward the paid total. Defensive null-guards prevent it from crashing the dashboard; it was the cause of the "blank screen on search" incident.
- **`class_fees_duplicates_backup`** table holds duplicate fee rows removed during the reconcile dedup; safe to drop after a confidence period.

## Product/behavioural limitations (by design)

- **Published fees cannot be corrected in-place within a session** (immutability trigger). To change a fee you wait for the next session. (ADR-005)
- **Future (virtual) sessions hold no data and are non-editable** until naturally created. (ADR-009)
- **The student credential is called both "PIN" and "password"** across the UI and can be 4-digit or a short alphanumeric depending on the path (`ChangePinPage` enforces 4 digits; `ResetPassword`/`student-set-pin` allow ≥4 chars). This inconsistency is cosmetic but confusing; worth unifying.
- **No self-service email change** for staff; only password change (in-app) and reset (via email link).
- **The bundle is ~1 MB** (single chunk) — a Vite build warning, not code-split. Fine for now.

## Legacy / dead code to be aware of

- **Zendfi flow** (`create-zendfi-payment`, `zendfi-webhook`, `student-payment`, `nigerianBanks` for some paths) — deployed but not used by the UI. (ADR-012)
- **`fee_items` table** — legacy per-student fee instances, superseded by `class_fees` + computed balances. Only the legacy `student-payment` function touches it.
- Earlier prototype pages were removed; the live dashboards are `SchoolAdminDashboard.tsx` / `SchoolStudentDashboard.tsx`.

## Things that will bite you if you forget them

- **Virtual session ids (`future-…`) are not UUIDs** — never let one reach a DB filter (`22P02`). Guard with `isFutureSession`.
- **The Paystack gross-up formula is duplicated** in the edge function and the student dashboard — keep them identical. (`07-payments.md`)
- **New student-facing reads of `class_fees` must add `.eq("status","published")`** — this gate lives in three payment/auth functions and is easy to omit in a fourth.
- **After any schema change, update `src/integrations/supabase/types.ts` by hand** (or regenerate from the live project) or `tsc` will drift from reality.
- **Production carries un-named legacy RLS/objects** — when tightening security, prefer "drop ALL policies on the table, recreate the canonical set" over `drop policy if exists <known-name>`, or a stray permissive policy survives (this happened twice).
