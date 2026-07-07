# 04 — Authentication & Authorization

EduLedgerNG runs **two completely independent auth systems** side by side: staff (owners and bursars) authenticate with real Supabase email + password auth and get a JWT session; students authenticate with a `student_id` + PIN pair that is **never** verified in the browser — it is checked server-side by the `student-auth` edge function via the `verify_student_pin` RPC. These two systems share no session, no storage keys, and no identity table, and the student "session" is nothing more than credentials cached in `localStorage` and replayed to edge functions on every privileged action.

> This document is the reference for who-is-who and how they prove it. For what each role is then *allowed* to do at the database level, see `03-security-rls.md`. For the payment actions students trigger, see `07-payments.md`. For the bursar-invitation lifecycle, see `06-user-workflows.md`.

---

## 1. The two systems at a glance

| Aspect | Staff (owner / bursar) | Student |
| --- | --- | --- |
| Identity | Supabase `auth.users` row + `profiles` row | `students` table row (no `auth.users`) |
| Credential | email + password (Supabase GoTrue) | `student_id` + PIN (plaintext `students.pin`) |
| Where verified | Supabase Auth server (real JWT) | `student-auth` edge fn → `verify_student_pin` RPC (service role) |
| Session token | Supabase JWT in `localStorage` (`sb-*`) | none — credentials cached under `pity_*` keys |
| Session provider | `src/lib/supabaseAuthContext.tsx` | `src/lib/schoolContext.tsx` |
| Role model | `school_admins.role` = `owner` \| `bursar`, per school | n/a (all students equal) |
| Forced rotation flag | `profiles.must_change_password` | `students.must_change_pin` / `is_first_login` |
| Login entry points | `/login`, `/owner-login`, `/register`; Admin tab on `/school/:slug` | Student tab on `/school/:slug` |
| Lands on | `/main-dashboard` or `/school/:slug/admin` | `/school/:slug/student` |
| RLS posture | anon key + JWT, policies keyed on `auth.uid()` | anon key, **no** JWT — all reads/writes proxied through service-role edge fns |

The browser always uses the **anon/publishable key** (hardcoded in `src/integrations/supabase/client.ts`). RLS is the enforcement floor for staff; for students there is effectively no RLS identity at all, so every student data path must go through an edge function running as service role. See `03-security-rls.md`.

---

## 2. Staff authentication (Supabase email + password)

### 2.1 Identity tables

| Table | Key columns | Notes |
| --- | --- | --- |
| `auth.users` | `id`, `email`, `encrypted_password` | Managed by Supabase GoTrue |
| `profiles` | `id` (= `auth.users.id`, PK, FK on delete cascade), `email`, `full_name`, `avatar_url`, `must_change_password` | **No `user_id` column** — `id` *is* the auth uid. Auto-created by trigger. |
| `school_admins` | `id`, `school_id`, `user_id`, `role` (`owner`\|`bursar`, default `bursar`), `unique(school_id, user_id)` | Links a user to a school with a role. One user can hold rows in many schools. |
| `schools` | `id`, `owner_id`, `slug`, … | `owner_id` is the canonical owner; note it is **not** a FK and can diverge from `school_admins` (see §6). |

`profiles` rows are auto-created on signup by the `handle_new_user()` trigger (`AFTER INSERT ON auth.users`) — `baseline_live_schema.sql:25-40`. It copies `email` and `raw_user_meta_data->>'full_name'` into `profiles`, `ON CONFLICT (id) DO UPDATE`. Note this trigger does **not** set `must_change_password` — that column defaults to `false` (`harden_bursar_rls.sql:18`) and is only flipped to `true` by `add-bursar` for directly-created bursars.

### 2.2 The roles model

Role lives in `school_admins.role`, **per school** — a user can be `owner` of school A and `bursar` of school B simultaneously. Two RLS helper functions encode the hierarchy (both `security definer`, `stable`):

| Function | Returns true when caller… | Definition |
| --- | --- | --- |
| `is_school_member(school_id)` | is `schools.owner_id` **OR** has any `school_admins` row for the school | `baseline_live_schema.sql:202` |
| `is_school_owner(school_id)` | is `schools.owner_id` **OR** has a `school_admins` row with `role = 'owner'` | `fee_approval_workflow.sql:61` |

Bursar = member-but-not-owner. The distinction gates: publishing fees, editing school/bank settings, updating/deleting students, and adding/removing staff — all owner-only (see `harden_bursar_rls.sql` and `03-security-rls.md`).

### 2.3 Registration flow (`/register` → `RegisterPage.tsx`)

1. Client-side validation: all three fields non-empty, password ≥ 6 chars (`RegisterPage.tsx:22-29`).
2. `supabase.auth.signUp({ email, password, options: { data: { full_name } } })` (`:32`).
3. On success with a `data.user`: toast, navigate to `/register-school?welcome=true` (`:46-48`).
4. If `data.user` is falsy (email-confirmation-required projects): toast "check your email", navigate to `/owner-login` (`:49-52`).
5. The `handle_new_user` trigger creates the `profiles` row server-side.

> NOTE: The two-branch logic assumes email confirmation *may* be on, but in practice confirmation is off (bursars are created with `email_confirm: true`, and there is no resend-confirmation UI). The `/register-school` step is where the first `schools` row and the owner's `school_admins` row are created (see `01-architecture.md` / `register-school` function).

### 2.4 Login flow — two distinct entry points

**A. Global owner login (`OwnerLogin.tsx`, served at both `/login` and `/owner-login`):**

1. `supabase.auth.signInWithPassword({ email, password })` (`OwnerLogin.tsx:42`).
2. On error → toast the raw GoTrue message, stop.
3. On success → `navigate("/main-dashboard")` unconditionally (`:53`). **No role check here** — role/school resolution happens on the dashboard.

**B. Per-school admin login (Admin tab of `SchoolPortal.tsx`):**

1. `signInWithPassword` (`SchoolPortal.tsx:118`).
2. Fetch the school by slug, selecting `owner_id` (`:130-134`).
3. `isOwner = school.owner_id === data.user.id` (`:143`).
4. If not owner, look for a `school_admins` row matching `(school_id, user_id)` (`:145-150`).
5. If neither → toast "You are not an admin of this school", **`supabase.auth.signOut()`**, stop (`:152-157`). This sign-out is important: the JWT was already minted in step 1, so a wrong-school login must be torn down.
6. Otherwise → `navigate("/school/:slug/admin")` (`:160`).

> GOTCHA: The two login paths land users in different places and apply different gating. `/login` never verifies school membership (it just lists whatever schools the user belongs to); the portal Admin tab verifies membership of *that* school before letting you in.

### 2.5 Login-to-dashboard routing (staff)

| Path taken | Guard on arrival | Ends at |
| --- | --- | --- |
| `/login` or `/owner-login` → `/main-dashboard` | `Dashboard.tsx` re-checks `getUser()`; if `must_change_password` → `/change-password` | school list (all schools with any role) |
| Portal Admin tab → `/school/:slug/admin` | `SchoolAdminDashboard.tsx` re-checks `getUser()` + `must_change_password` + role | that school's admin dashboard |

Both dashboards re-run `supabase.auth.getUser()` on mount and bounce to a login page if there is no user (`Dashboard.tsx:65-69`, `SchoolAdminDashboard.tsx:414-418`). `SchoolAdminDashboard` additionally verifies the school exists and stores `school_admins.role` into `userRole` (`:447-454`) to drive owner-only UI. It does **not**, however, block a non-member from viewing the dashboard — it sets `userRole = null` and continues; the actual protection is RLS on the underlying queries.

### 2.6 The session provider (`supabaseAuthContext.tsx`)

Exposes `{ isReady, isSignedIn }`. On mount it calls `getSession()`; if there is an error or no session it runs `clearAuthState()`; otherwise `isSignedIn = true` (`:58-70`). It also subscribes to `onAuthStateChange` and reacts to `SIGNED_OUT`/`SIGNED_IN`/`TOKEN_REFRESHED`/`USER_UPDATED` (`:72-83`).

`clearAuthState()` (`:18-56`) is the white-screen defense (see §5). It:
- removes `sb-auth-token`, `sb-refresh-token`, `supabase.auth.token`, `supabase.auth.expires_at`, **and** all `pity_*` student keys;
- sets `isSignedIn = false`;
- **does not redirect** if the path starts with `/school/` (so the portal still renders its login buttons) or `/account-recovery` (so the recovery token can be exchanged) — the "LOOP BREAKER SHIELD" (`:42-47`);
- otherwise, if not already on `/`, hard-redirects to `/`.

> GOTCHA: `clearAuthState` clears the `pity_*` student keys too, even though those belong to the entirely separate student system. In practice a browser is only ever one or the other, but a device shared between a staff logout and a logged-in student would wipe the student session.

---

## 3. Password lifecycle (staff)

### 3.1 Forced rotation — `must_change_password`

Set to `true` only when an owner creates a bursar **directly** with a temporary password (`add-bursar/index.ts:118-123`, MODE 2). The flag is enforced in **three** places, each redirecting to `/change-password` before rendering:

| Enforcement point | File:line |
| --- | --- |
| Main dashboard load | `Dashboard.tsx:77-85` |
| Admin dashboard load | `SchoolAdminDashboard.tsx:423-431` |
| Change-password page itself (to show the "set your own password" copy) | `ChangePassword.tsx:33-38` |

`ChangePassword.tsx` (`:62-70`) calls `supabase.auth.updateUser({ password })` — no email link needed because the bursar is already signed in with the temp password — then clears the flag via `profiles.update({ must_change_password: false })` and navigates to `/main-dashboard`. When `forced`, the "Back to Dashboard" escape hatch is hidden (`:154-164`), so the bursar cannot skip rotation.

> GOTCHA: There is no server-side gate forcing rotation — a bursar who navigates directly to `/school/:slug/admin` API-level (or hits the DB via the anon key) is only stopped by the client-side redirect. The flag is UX, not a security boundary.

### 3.2 Self-service change (signed in)

Same `ChangePassword.tsx` page, `forced = false` branch: any signed-in staff member can change their password. Reachable from the key icon in both dashboard headers (`Dashboard.tsx:277`, `SchoolAdminDashboard.tsx:1081`). Validation: ≥ 6 chars, must match confirm (`:46-53`).

### 3.3 Password recovery (forgot password)

The email-link flow, entirely inside Supabase GoTrue:

1. On `OwnerLogin`, the user types their email and clicks "Forgot password?" → `handleForgotPassword` (`OwnerLogin.tsx:20-36`).
2. `supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo: \`${window.location.origin}/account-recovery\` })` (`:27-29`). Email is lowercased/trimmed first.
3. The email link returns the user to `/account-recovery` with a recovery token in the URL fragment.
4. `AccountRecovery.tsx` polls `getSession()` up to 10× at 500 ms (`:29-42`) while supabase-js exchanges the token for a recovery session. `sessionReady` is `null` (spinner) → `true` (form) → `false` (expired/invalid link, "Back to Login").
5. On submit: `updateUser({ password })` (`:60`), then `navigate("/main-dashboard")`.

**Critical operational requirement:** the exact `${origin}/account-recovery` URL must be in each Supabase project's **Auth → URL Configuration → Redirect URLs allowlist** — otherwise GoTrue refuses the `redirectTo` and the link is rejected. This must be configured in the hosted dashboard per project; `supabase config push` cannot be used (it 402s on paid-tier settings) — see CLAUDE.md §"Password recovery". `clearAuthState` deliberately exempts `/account-recovery` from its redirect (`supabaseAuthContext.tsx:44`) so the polling in step 4 can complete.

> GOTCHA: `AccountRecovery.tsx` and `ChangePassword.tsx` are near-duplicate pages. `AccountRecovery` is the *unauthenticated-arrival* path (token from email); `ChangePassword` is the *already-signed-in* path. Do not merge them without preserving the token-polling in the former.

---

## 4. Student authentication (student_id + PIN)

### 4.1 Identity + the verify RPC

Students live only in `public.students` (`baseline_live_schema.sql:93-113`). Relevant columns:

| Column | Type | Role in auth |
| --- | --- | --- |
| `student_id` | text (not null), `unique(school_id, student_id)` | Login handle. Matched **case-insensitively** (`upper()` both sides). |
| `pin` | text (not null) | **Plaintext** credential. Compared with `=`. |
| `default_pin` | text | The last-set PIN, kept in sync by `student-set-pin` (`:60-66`). |
| `must_change_pin` | boolean default `true` | Drives the first-login reset. |
| `is_first_login` | boolean default `true` | Cleared alongside `must_change_pin`; not read on the login path. |
| `status` | text default `active` | `verify_student_pin` treats `inactive` as non-existent. |
| `failed_login_attempts` | int default 0 | Lockout counter (added `fix_verify_student_pin_lockout.sql:12`). |
| `locked_until` | timestamptz | Lockout expiry (`:13`). |
| `class` | text | Used to select applicable `class_fees` (`class_target IN (class,'ALL')`). |
| `name`, `session`, `term`, `school_id`, `session_id`, `term_id` | | Returned to the client / used for fee scoping. |

**`verify_student_pin(p_school_id uuid, p_student_id text, p_pin text)`** — `security definer`, `set search_path = public`, canonical definition in `fix_verify_student_pin_lockout.sql:29-91`. Behavior:

1. Look up the student by `(school_id, upper(student_id))` where `coalesce(status,'active') <> 'inactive'`.
2. If none → `RETURN` (empty result = "invalid credentials").
3. If `locked_until` is in the future → `RETURN` (locked out; indistinguishable from wrong-PIN to the caller).
4. If `pin = p_pin` → reset `failed_login_attempts = 0`, `locked_until = null`, return one row `(id, student_id, name, class, school_id, session, term, must_change_pin)`.
5. Else → increment `failed_login_attempts`; if it reaches **≥ 5**, set `locked_until = now() + 15 minutes`; `RETURN` empty.

> HISTORY / DEBT: the **drifted production** `verify_student_pin` (hand-built, differing from the baseline file — whose plain-SQL version never referenced `locked_until`) referenced `locked_until` but the production `students` table lacked the column, so **every** student login 500'd with `record "v_student" has no field "locked_until"`. `fix_verify_student_pin_lockout.sql` adds the two columns and replaces the function with a self-consistent version. On production this migration must be run manually via the SQL editor (CLI is linked to staging). The lockout is per-student-row and resets on any successful login; there is no IP-based throttle and no CAPTCHA.

### 4.2 The `student-auth` edge function

`SchoolPortal.tsx` → Student tab → `handleStudentLogin` (`:54-112`):

1. `student_id` is `.trim().toUpperCase()`, `pin` is `.trim()` (`:59-60`).
2. `supabase.functions.invoke("student-auth", { body: { school_slug: slug, student_id, pin } })` (`:64-66`).
3. The function (`student-auth/index.ts`) runs as **service role**:
   - Validates presence + type/length: `student_id ≤ 30`, `pin ≤ 10`, `school_slug ≤ 100` (`:19-34`).
   - Resolves the school by slug (`:42-46`); 404 if missing.
   - Calls `verify_student_pin` (`:63-68`); empty result → **401 "Invalid Student ID or PIN"** (`:77-82`).
   - Loads `published` `class_fees` for `class_target IN (student.class, 'ALL')`, optionally filtered by `session_id`/`term_id` (`:88-98`).
   - Loads the student's `payments`, optionally period-filtered (`:108-117`).
   - Computes each fee's `paid` by summing payment `items` entries of the form `"<name>|<amount>"` split on the **last** `|`, capped at the fee `amount`; derives `status` ∈ `paid`/`partial`/`unpaid` (`:127-152`).
   - Also returns the school's `sessions` and `terms` lists (`:154-180`).
   - Responds `{ student, school, feeItems, payments, sessions, terms }`.

Only **published** fees are ever returned (`status = "published"`, `:92`) — this filter is duplicated across `student-auth`, `create-paystack-payment`, and `create-zendfi-payment`; any new student-facing read of `class_fees` must add it too (CLAUDE.md §"Fee approval workflow").

### 4.3 Login-to-dashboard routing (student)

Back in `handleStudentLogin`:

| Condition | Action |
| --- | --- |
| `error` or `data.error` | toast the error, stop (`:68-71`) |
| no `data.student` | toast "Invalid Student ID or PIN" (`:73-77`) |
| `student.must_change_pin === true` | toast, `navigate("/school/:slug/reset-password", { state: { studentId, currentPin } })` (`:81-87`) |
| otherwise | `loginStudent(...)` caches session, `navigate("/school/:slug/student")` (`:89-105`) |

So a first-login student is diverted to **`/reset-password`** (the `ResetPassword.tsx` page), *not* `/change-pin`. The current PIN is passed in router `state` (in memory only, not URL) so the reset page can prove it server-side.

### 4.4 First-login reset (`ResetPassword.tsx` → `student-set-pin`)

- Guards: if `location.state.studentId` is missing, bounce to `/school/:slug` (`:27-32`, `:52-56`). Because state is in-memory, a **refresh on the reset page loses it** and kicks the student back to the portal.
- Validation: new password ≥ **4** chars, matches confirm (`:42-50`). (Note: this page calls the value a "password", accepts ≥ 4 chars — not restricted to 4 digits like a PIN.)
- `supabase.functions.invoke("student-set-pin", { body: { school_slug, student_id, current_pin, new_pin } })` (`:62-69`).
- `student-set-pin` (`student-set-pin/index.ts`): re-verifies `current_pin` via `verify_student_pin` (with lockout), then updates `pin`, `default_pin`, `must_change_pin = false`, `is_first_login = false` (`:58-66`). New value must be 4–50 chars (`:31-33`).
- On success → toast, `navigate("/school/:slug")` — the student must **log in again** with the new credential; the reset does not auto-login.

### 4.5 Change PIN when signed in (`ChangePinPage.tsx` → `change-pin`)

- Route `/school/:slug/change-pin` (`App.tsx:46`). Guard: requires `student` + `studentCredentials` in `schoolContext`, else bounce to portal (`ChangePinPage.tsx:23-26`).
- Validation is **stricter** than the first-login page: exactly 4 digits (`/^\d{4}$/`), must match confirm, must differ from current PIN (`:31-42`).
- `change-pin/index.ts`: verifies `old_pin` via `verify_student_pin`, then updates `pin`, `must_change_pin`, `is_first_login` (`:67-70`). Server also enforces the 4-digit rule (`:23-28`). Note this function updates `pin` but **not** `default_pin` (unlike `student-set-pin`) — a small inconsistency.
- On success it re-caches the session in-place via `loginStudent(..., { pin: newPin })` (`:62-67`) and stays logged in, navigating to `/school/:slug/student`.

> GOTCHA: Nothing in the app navigates to `/school/:slug/change-pin` — grep finds no link (only `App.tsx` route + the page itself). It is effectively reachable only by typing the URL. The first-login path uses `/reset-password` instead. Treat `change-pin`/`ChangePinPage` as an orphaned-but-wired feature.

### 4.6 The student "session" (`schoolContext.tsx` + `pity_*`)

There is no student token. `SchoolProvider` holds `{ school, student, feeItems, payments, studentCredentials, schoolSlug }` in React state, mirrored to `localStorage`:

| Key | Contents |
| --- | --- |
| `pity_student` | `StudentData` (id, student_id, name, class, term, session, school_id, must_change_pin) |
| `pity_fees` | computed `FeeItem[]` |
| `pity_payments` | `PaymentRecord[]` |
| `pity_credentials` | `{ student_id, pin }` — **plaintext PIN in localStorage** |
| `pity_school` | `{ id, name }` |
| `pity_slug` | school slug (string) |

`loginStudent()` writes all of these (`:97-112`); `logoutStudent()` removes them (`:121-134`). State is initialized from storage on mount so a refresh survives (`:82-89`). Every privileged student action (dashboard refresh, change-PIN, pay) re-sends `studentCredentials` to an edge function — e.g. the dashboard's period-refresh re-invokes `student-auth` with the cached PIN on every session/term change (`SchoolStudentDashboard.tsx:84-113`), and payment uses `studentCredentials.pin` (`:455`).

> SECURITY DEBT: the PIN is stored in cleartext in `localStorage` and re-transmitted on every action. Because students have no JWT, this cached credential *is* the session. There is no expiry — a `pity_credentials` entry is valid until the PIN changes or the keys are cleared. Combined with plaintext `students.pin` in the DB, PINs are low-security throughout. See `03-security-rls.md` for the RLS caveat that `students` reads are now member-scoped (so the browser can no longer read PINs directly after `harden_bursar_rls.sql`).

---

## 5. White-screen history & defensive parsing

Two deliberate defenses (CLAUDE.md §"Error handling / white screens", `WHITESCREENFIX.md`):

1. **`readStored` / `writeStored`** in `schoolContext.tsx` (`:58-78`). A corrupt localStorage value — classically the literal string `"undefined"` — would throw in `JSON.parse` **during provider initialization**, i.e. before `ErrorBoundary` can catch it, producing a blank page. `readStored` wraps parse in try/catch and, on failure, deletes the bad key and returns a typed fallback. `writeStored` swallows quota/availability errors so in-memory state keeps working. Preserve these guards.
2. **Aggressive `clearAuthState`** in `supabaseAuthContext.tsx` (§2.6). Stale/failed Supabase sessions are cleared eagerly rather than left to error mid-render, with the two path-based redirect exemptions (`/school/*`, `/account-recovery`) that prevent redirect loops.

`ErrorBoundary` wraps the whole tree (`App.tsx:29`). The defensive null-guards in `SchoolStudentDashboard` (e.g. `feeItems = []` default, `Number(f?.amount || 0)`, `:117-137`) exist for the same reason — a partially-populated cached session must not crash math.

---

## 6. Assumptions, limitations, edge cases, failure modes

**Assumptions**
- One browser is either a staff session or a student session, never both (they share `localStorage` and `clearAuthState` wipes both key sets).
- `schools.owner_id` and a matching `school_admins` `role='owner'` row agree. Ownership checks in `is_school_owner`, `SchoolPortal`, and `add-bursar` all accept **either**, so a divergence is tolerated but confusing.
- PINs are 4 digits *by convention*; the DB column is free text and `student-set-pin` accepts 4–50 chars, so a "PIN" set via the first-login page can be a longer password.

**Limitations / debt**
- Plaintext PINs (DB column + `pity_credentials`), no PIN hashing.
- Student "session" has no expiry or revocation — clearing localStorage or changing the PIN are the only invalidation mechanisms.
- Lockout is per-student-row only (5 attempts → 15 min); no IP throttle, shared across the reset/change/login paths since all call `verify_student_pin`.
- `must_change_password` and `must_change_pin` redirects are **client-side only** — not security boundaries.
- `change-pin`/`ChangePinPage` is orphaned (no navigation to it).
- `change-pin` updates `pin` but not `default_pin`; `student-set-pin` updates both — an inconsistency in what `default_pin` means over time.
- Duplicate password-reset UIs (`AccountRecovery` vs `ChangePassword`) and duplicate PIN-reset UIs (`ResetPassword` vs `ChangePinPage`).

**Edge cases / failure modes**
- Refreshing `/school/:slug/reset-password` loses the in-memory `studentId`/`currentPin` state → student is bounced to the portal and must log in again (which re-triggers the first-login redirect).
- Recovery link fails if `/account-recovery` isn't in the project's Redirect URL allowlist, or if the token is already used/expired (`sessionReady === false` UI).
- Two production schools have `slug = NULL` and are unreachable via `/school/:slug`, so neither student nor per-school-admin login works for them (CLAUDE.md §"Known issues").
- Wrong-school admin login mints a JWT then signs out (`SchoolPortal.tsx:138,155`); a network failure between those two calls could leave a signed-in-but-unauthorized-for-this-school session (harmless — global `/main-dashboard` still gates by membership via RLS).
- `student-auth` returns `500 "Database connection error"` (not 401) for any DB error, so a schema drift like the historical `locked_until` bug surfaces as a 500, not an auth failure — useful signal when debugging "students can't log in."

> NOTE: I did not exhaustively read every `useEffect` in `SchoolAdminDashboard.tsx` (~1700 lines) or `SchoolStudentDashboard.tsx`; the auth-relevant guards (mount `getUser`, `must_change_password`, role fetch, student re-auth on period change) are documented above and verified by line number. Reviewer should confirm no *additional* auth redirect exists deeper in those files.
