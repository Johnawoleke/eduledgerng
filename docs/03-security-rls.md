# 03 — Security & RLS Model

EduLedgerNG's untrusted browser talks **directly to Postgres** through PostgREST using a public, hardcoded anon (publishable) key, so **Row-Level Security is the only real security boundary** — the "enforcement floor." This document is the authoritative, table-by-table reference for every RLS policy, the helper functions (`is_school_member`, `is_school_owner`, `verify_student_pin`), the student PIN-lockout, and the residual security debt still live in the schema. For the auth flows themselves see `04-authentication.md`; for the payment/webhook trust model see `07-payments.md`; for the schema drift story see `02-data-model.md`.

> NOTE: All line/policy citations below are against the migration files as of 2026-07-07. The *effective production state* is the cumulative result of the migration chain, not any single file — see [§2 Migration evolution](#2-migration-evolution-how-the-policies-got-here).

---

## 1. The enforcement floor principle

### 1.1 Why RLS, not application code

The frontend Supabase client (`src/integrations/supabase/client.ts:8-10`) is constructed with a **hardcoded, public publishable key**:

```ts
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  || "sb_publishable_dz8sfx1QwMpIHe6is9NIUQ_067PGY1g";
```

This is intentional (`notes/supabase-env-vars.md`, CLAUDE.md "Hardcoded Supabase URL + anon key"). The consequence for security is absolute:

- **Anyone** can extract this key from the shipped JS bundle and issue arbitrary PostgREST queries (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, RPC) against every table.
- The React app's "you can only click this button if you're an owner" checks are **cosmetic**. An attacker never runs the React app; they `curl` the REST endpoint.
- Therefore **any access rule that matters must be a Postgres RLS policy or a `SECURITY DEFINER` function** — not a guard in a `.tsx` file. Every migration in this repo that says "the UI hid a button but the database still allowed the action" (e.g. `20260707120000_harden_bursar_rls.sql:2-9`) is closing exactly this gap.

### 1.2 The two ways to escalate past the anon key

There are exactly two mechanisms in this system that legitimately act with more privilege than the anon key:

| Mechanism | How it bypasses RLS | Used for |
|---|---|---|
| **Service-role edge functions** (`supabase/functions/*`) | Construct a client with `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses RLS entirely**. | All privileged writes: student PIN set/verify, school/bursar creation, payment recording. |
| **`SECURITY DEFINER` functions** | Run as the function *owner* (superuser), not the caller, so they can read/write tables the caller's RLS forbids. | `is_school_member`, `is_school_owner`, `verify_student_pin`, `handle_new_user`. |

Every table's writes for `students`, `school_admins`, `school_requests`, `payments`, `payment_events`, and `profiles` (insert) are funneled through one of these — clients get **read-mostly** access.

### 1.3 The one thing even the service role cannot bypass

A `BEFORE UPDATE OR DELETE` **table trigger** runs regardless of the connection's role. `protect_published_class_fees` (`20260707090000_fee_approval_workflow.sql:20-55`) therefore locks published fees **even against the service role** — see [§6](#6-the-published-fee-lock-trigger). This is the only place in the schema where a service-role edge function is *not* omnipotent.

---

## 2. Migration evolution (how the policies got here)

The RLS surface was rewritten several times. The **effective final state** is the cumulative result; earlier policies were dropped/replaced. Read the matrix in [§4](#4-the-policy-matrix) as authoritative and use this table only to understand *why* a given policy exists.

| Migration | What it did to security |
|---|---|
| `20260706120000_baseline_live_schema.sql` | Enabled RLS on all 11 tables. Created **permissive/open** policies reflecting the then-current app: `students` SELECT+UPDATE `using(true)` (anon could read **plaintext PINs** and reset any PIN), `schools` SELECT `using(true)`, `schools` UPDATE = any member. Defined `is_school_member` and the **original** `verify_student_pin` (no lockout). |
| `20260706130000_reconcile_live_schema.sql` | Added `sessions`/`terms`/`class_fees`/`payments`/`school_requests` policies (mostly `select using(true)` + member-manage). Added unique indexes (`payments_reference_key`, `class_fees_...period_key`) that back idempotent webhook/upsert writes. |
| `20260707090000_fee_approval_workflow.sql` | Added `class_fees.status` + the `protect_published_class_fees` trigger. Defined **`is_school_owner`**. Split the blanket `class_fees` policy into select/insert/update/delete with the pending/published rules. |
| `20260707100000_fix_verify_student_pin_lockout.sql` | Added `students.failed_login_attempts` + `students.locked_until`. Dropped **all** `verify_student_pin` overloads and recreated one canonical version implementing the **5-strike / 15-min lockout**. (Fixed a production 500: the function referenced `locked_until` before the column existed.) |
| `20260707120000_harden_bursar_rls.sql` | Closed the plaintext-PIN read and bursar-write holes: `students` SELECT → `is_school_member`, UPDATE/DELETE → `is_school_owner`; `schools` UPDATE → owner-only (settlement account); added `profiles.must_change_password`; `school_admins` DELETE (owner, not self); `school_requests` owner read/cancel. |
| `20260707140000_reset_core_policies.sql` | **Nuked every existing policy** on `students, schools, school_admins, school_requests, class_fees, profiles` (to kill stray Lovable-era `using(true)` policies the named `drop`s had missed) and recreated only the canonical set. Added the **owner-can-read-member-profiles** policy. This is the authoritative source for those 6 tables. |
| `20260707160000_students_no_delete.sql` | Dropped the `students` DELETE policy entirely → **no client can hard-delete a student** (archive-only). |

> NOTE: `20260707140000_reset_core_policies.sql` only reset **6 tables**. It did **not** touch `sessions`, `terms`, `payments`, `fee_items`, or `payment_events`. On production, any older differently-named Lovable-era policy on *those* five tables could still be OR'ing in extra access. This is listed as debt in [§8](#8-residual-security-debt).

---

## 3. Helper functions (the RLS predicates)

All three are `SECURITY DEFINER SET search_path = public`, so they read `schools`/`school_admins`/`students` regardless of the caller's RLS.

### 3.1 `is_school_member(school_id_param uuid) → boolean`
`20260706120000_baseline_live_schema.sql:202-213`, `LANGUAGE sql STABLE`.

```sql
returns true if:
  schools.owner_id = auth.uid()            -- the registrant/owner
  OR any school_admins row (school_id, user_id=auth.uid())  -- ANY role
```

"Member" = owner **or any admin regardless of role**. Bursars are members. Used for read access and for actions any staffer may perform.

### 3.2 `is_school_owner(school_id_param uuid) → boolean`
`20260707090000_fee_approval_workflow.sql:61-72`, `LANGUAGE sql STABLE`.

```sql
returns true if:
  schools.owner_id = auth.uid()
  OR school_admins row (school_id, user_id=auth.uid(), role = 'owner')
```

"Owner" = the registrant **or** an admin whose `role = 'owner'`. Bursars (`role = 'bursar'`) are **excluded**. Used for privileged writes (edit/delete students, change settlement account, publish fees, off-board staff).

> Relationship: every owner is also a member; every bursar is a member but not an owner. `register-school/index.ts:191-194` inserts the registrant into `school_admins` with `role='owner'`, so an owner satisfies *both* the `owner_id` branch and the `role='owner'` branch — this redundancy matters for the profiles policy in §4.1.

### 3.3 `verify_student_pin(...)` — see [§7 (PIN lockout)](#7-student-pin-verification--lockout).

---

## 4. The policy matrix

Legend for the "who" columns — **✔** = allowed, **�’** = allowed with a condition (see notes), **�’ (svc)** = only via a service-role edge function (RLS bypassed), **✘** = no policy → denied for clients.

- **anon** = unauthenticated request bearing the public publishable key (student portal, pre-login pages, *and any attacker*).
- **student** = the same anon key; **students have no Supabase JWT**, so at the RLS layer a logged-in student is indistinguishable from anon. Their privileged actions go through edge functions (`student-auth`, `student-set-pin`, `change-pin`, `create-paystack-payment`).
- **bursar** = an authenticated admin with `school_admins.role='bursar'` for that school (a member, not an owner).
- **owner** = the school's `owner_id`, or an admin with `role='owner'` (a member and an owner).
- **service** = a `SUPABASE_SERVICE_ROLE_KEY` edge-function client; **bypasses all RLS**.

### 4.1 `profiles` — `20260707140000_reset_core_policies.sql:84-101`

| Op | anon | bursar | owner | service | Rule |
|---|---|---|---|---|---|
| SELECT | ✘ | �’ own | �’ own + members + invitees | ✔ | `id = auth.uid()` OR (caller is `role='owner'` admin of a school the target is a member of) OR (target is the `user_id` of a `school_requests` row the caller sent/owns) |
| INSERT | ✘ | ✘ | ✘ | ✔ | No client policy — created by `handle_new_user` trigger (SECURITY DEFINER) on `auth.users` insert |
| UPDATE | ✘ | ✔ own | ✔ own | ✔ | `id = auth.uid()` (both `using` + `with check`) |
| DELETE | ✘ | ✘ | ✘ | ✔ (cascade) | No policy; cascades from `auth.users` delete |

**Owner-can-read-members policy (why it exists):** the owner's staff list needs bursars' names/emails, but making `profiles` anon-readable would leak every user's email to the public key. The self-join (`sa_owner` role='owner' ⋈ `sa_member` on same `school_id`) grants exactly: *my own profile*, *profiles of members of schools I own*, and *profiles of people I have an outstanding invite to*. Nothing more.

> NOTE: this policy keys off the caller having a `school_admins` row with `role='owner'`. An owner represented **only** via `schools.owner_id` (no admins row) would *not* see staff profiles. In practice `register-school` always inserts the `role='owner'` admins row, so this is a latent edge case, not a live bug.

### 4.2 `schools` — `20260707140000_reset_core_policies.sql:43-47`

| Op | anon | bursar | owner | service | Rule |
|---|---|---|---|---|---|
| SELECT | **✔** | ✔ | ✔ | ✔ | `using (true)` — portals/slug lookups show the school name pre-login |
| INSERT | ✘ | ✘ | ✘ | ✔ | Via `register-school` |
| UPDATE | ✘ | **✘** | ✔ | ✔ | `is_school_owner(id)` |
| DELETE | ✘ | ✘ | ✘ | ✔ | No policy |

**Why UPDATE is owner-only (settlement account):** the school row carries the payout destination — `bank_name`, `account_number`, `account_name` — and `settings` (which caches `paystack_subaccount_code`). A bursar who could `UPDATE schools` could **redirect where every student's money settles**. `20260707120000_harden_bursar_rls.sql:42-50` narrowed this from "any member" to `is_school_owner` for exactly that reason.

> ⚠️ **Debt:** `SELECT using(true)` means the **anon key can read every school's `account_number`/`account_name`/`bank_name` and `settings`** across all tenants. See [§8](#8-residual-security-debt).

### 4.3 `students` — `20260707140000_reset_core_policies.sql:32-40` + `20260707160000_students_no_delete.sql`

| Op | anon | bursar | owner | service | Rule |
|---|---|---|---|---|---|
| SELECT | **✘** | ✔ | ✔ | ✔ | `is_school_member(school_id)` |
| INSERT | ✘ | **✔** | ✔ | ✔ | `is_school_member(school_id)` (adding/uploading students is a bursar task) |
| UPDATE | ✘ | **✘** | ✔ | ✔ | `is_school_owner(school_id)` |
| DELETE | ✘ | ✘ | **✘** | ✔ (cascade only) | **No policy** — DELETE dropped in `20260707160000` |

**Reads are member-only, writes are owner-only — why the split:** bursars must *view* the roster and balances and *add* students, so SELECT+INSERT are `is_school_member`. But **reset-PIN, editing, and archiving are owner tasks** (the dashboard gates those buttons to owners), so UPDATE is `is_school_owner`. DELETE was removed outright because **students are archived, never hard-deleted** (`SchoolAdminDashboard.tsx:568` sets `status:'archived'`; `:583` reactivates). A whole-school delete still cascades to students via the FK; only *individual* direct deletes are blocked (`20260707160000_students_no_delete.sql:4-8`).

**Why students were anon-readable historically, and why it was closed:** the baseline shipped `students` SELECT+UPDATE `using(true)` (`20260706120000...:272-275`) because the student portal's **first-login password reset page wrote directly to `students` from the browser** — it needed anon read+write. That exposed the **plaintext `pin` column to anyone holding the public key**. The fix had two halves: (1) move student self-service PIN changes into the `student-set-pin` service-role edge function (`ResetPassword.tsx:61-69` now invokes it — CLAUDE.md's note that ResetPassword writes `students` directly is **stale**), and (2) tighten the policies (`20260707120000` → `20260707140000`). `reset_core_policies` was necessary because named `drop policy` calls had missed older Lovable-era `using(true)` policies that, being *permissive*, OR'd anon reads back in (`20260707140000...:1-12`).

> ⚠️ **Debt:** the PIN is still stored **plaintext** (`students.pin text not null`, baseline `:108`). Closing anon read helped, but every school member can still `SELECT` the PIN, and `verify_student_pin` compares it literally. See [§8](#8-residual-security-debt).

**Gotcha (bursar can add but not edit/archive):** because INSERT is member but UPDATE is owner, a bursar can add a student yet **cannot** archive/reactivate/edit that same student — those calls (`SchoolAdminDashboard.tsx:568/583/598`) will silently affect 0 rows for a bursar. Confirm the dashboard hides those controls from bursars, or they will appear broken.

### 4.4 `school_admins` — `20260707140000_reset_core_policies.sql:52-55`

| Op | anon | bursar | owner | service | Rule |
|---|---|---|---|---|---|
| SELECT | ✘ | ✔ (self + school roster) | ✔ | ✔ | `user_id = auth.uid()` OR `is_school_member(school_id)` |
| INSERT | ✘ | ✘ | ✘ | ✔ | Via `add-bursar` / `handle-school-request` |
| UPDATE | ✘ | ✘ | ✘ | ✔ | **No policy — a member cannot escalate their own role** |
| DELETE | ✘ | ✘ | ✔ (others only) | ✔ | `is_school_owner(school_id) AND user_id <> auth.uid()` |

**No INSERT/UPDATE policy is deliberate** (`20260707120000...:52-57`): if a member could `UPDATE school_admins`, a bursar could set their own `role='owner'` and take over settlement. Role grants happen **only** via service-role functions that verify ownership. DELETE lets an owner off-board staff but **not remove themselves** (`user_id <> auth.uid()`), preventing an owner from orphaning the school.

### 4.5 `school_requests` (bursar invitations) — `20260707140000_reset_core_policies.sql:58-65`

| Op | anon | bursar/invitee | owner | service | Rule |
|---|---|---|---|---|---|
| SELECT | ✘ | ✔ (own invites) | ✔ (school's invites) | ✔ | `user_id=auth.uid()` OR `requested_by=auth.uid()` OR `is_school_owner(school_id)` |
| INSERT | ✘ | ✘ | ✘ | ✔ | Via `add-bursar` |
| UPDATE | ✘ | ✘ | ✘ | ✔ | Via `handle-school-request` |
| DELETE | ✘ | ✘ (unless inviter) | ✔ | ✔ | `requested_by=auth.uid()` OR `is_school_owner(school_id)` |

Invitees see invitations addressed to them; the owner/inviter can track and cancel them. Acceptance (writing the resulting `school_admins` row) is service-role only.

### 4.6 `class_fees` — `20260707140000_reset_core_policies.sql:69-78` (mirrors `20260707090000`)

| Op | anon / student | bursar | owner | service | Rule |
|---|---|---|---|---|---|
| SELECT | ✔ **published only** | ✔ all (incl. pending) | ✔ all | ✔ | `status='published' OR is_school_member(school_id)` |
| INSERT | ✘ | ✔ **as `pending` only** | ✔ as pending | ✔ | `is_school_member(school_id) AND status='pending'` |
| UPDATE | ✘ | ✔ **only while `pending`** | ✔ (publish/edit) | ✔ (but trigger-limited) | `is_school_owner` OR (`is_school_member AND status='pending'`) |
| DELETE | ✘ | ✘ | ✔ (pending only, trigger) | ✔ (pending only, trigger) | `is_school_owner(school_id)` |

The **fee-approval workflow**: members create fees as `pending`; only owners flip `pending → published`; students only ever see/pay `published` fees. Note the RLS `INSERT ... AND status='pending'` enforces "new fees are always pending" at the database, not just the UI. The `protect_published_class_fees` trigger ([§6](#6-the-published-fee-lock-trigger)) then makes published rows immutable **even for the service role and even for owners** — the only permitted transition is `pending → published`. See `08-sessions-fees.md` for the full lifecycle.

### 4.7 `sessions` & `terms` — `20260706130000_reconcile_live_schema.sql:97-124`

| Op | anon | bursar | owner | service | Rule |
|---|---|---|---|---|---|
| SELECT | **✔** | ✔ | ✔ | ✔ | `using(true)` — student dashboard reads periods with the anon key |
| INSERT/UPDATE/DELETE | ✘ | ✔ | ✔ | ✔ | `..._manage` is a single `FOR ALL` policy: owner (`schools.owner_id`) or **any** `school_admins` member of that school |

> NOTE: the `manage` predicate is an inline `EXISTS` on `schools.owner_id`/`school_admins`, equivalent to `is_school_member` — i.e. **bursars can create/delete sessions and terms** here (unlike students/fees, there's no owner-only gate on academic periods). Also, these two tables were **not** covered by `reset_core_policies`, so stray legacy policies could still be live on production (see [§8](#8-residual-security-debt)).

### 4.8 `payments` — `20260706130000_reconcile_live_schema.sql:143-145`

| Op | anon | bursar | owner | service | Rule |
|---|---|---|---|---|---|
| SELECT | **✔** | ✔ | ✔ | ✔ | `using(true)` — student dashboard reads its own payment history with the anon key |
| INSERT/UPDATE/DELETE | ✘ | ✘ | ✘ | ✔ | No client policy — **all writes via service-role webhook/verify functions** |

Payment *recording* is service-role only and idempotent on `payments.reference` (unique partial index `payments_reference_key`, `20260706130000...:27-28`), written twice-safe by both `paystack-webhook` (HMAC-verified) and `verify-paystack-payment`. See `07-payments.md`.

> ⚠️ **Debt:** `SELECT using(true)` → the anon key can enumerate **every payment of every school** (`amount`, `reference`, `student_id`). Cross-tenant read. See [§8](#8-residual-security-debt).

### 4.9 `fee_items` (legacy) — `20260706120000_baseline_live_schema.sql:281-282`

| Op | anon | member | service | Rule |
|---|---|---|---|---|
| SELECT | **✔** | ✔ | ✔ | `using(true)` |
| INSERT/UPDATE/DELETE | ✘ | ✘ | ✔ | No policy |

Legacy per-student fee instances; the live flow doesn't write these (paired with the unused `student-payment` function). Still anon-readable cross-tenant.

### 4.10 `payment_events` (webhook audit log) — `20260706120000_baseline_live_schema.sql:284-285`

| Op | anon | member | service | Rule |
|---|---|---|---|---|
| SELECT | **✔** | ✔ | ✔ | `using(true)` — also in the `supabase_realtime` publication for live UI updates |
| INSERT/UPDATE/DELETE | ✘ | ✘ | ✔ | No policy; written by webhook functions |

> ⚠️ **Debt:** rows carry a raw `payload jsonb` from gateway webhooks; `SELECT using(true)` exposes whatever that payload contains to the anon key.

---

## 5. Anon-readable summary (attack surface with just the public key)

Anyone with the shipped publishable key can `SELECT`:

| Table | Exposed | Sensitivity |
|---|---|---|
| `schools` | name, slug, **bank_name, account_number, account_name**, settings (subaccount code) | **High** — settlement/financial |
| `payments` | amount, reference, student_id, dates | **High** — cross-tenant financial |
| `payment_events` | event_type, status, raw `payload` jsonb | **Medium/High** — depends on payload |
| `class_fees` | published fees, all schools | Medium — mostly intended (fees shown pre-login) |
| `fee_items` | legacy fee rows | Low (legacy/unused) |
| `sessions`, `terms` | academic period names, all schools | Low |
| `students` | **nothing** (closed — was plaintext PINs) | — |
| `profiles`, `school_admins`, `school_requests` | **nothing** without a matching JWT | — |

The important wins: `students` (plaintext PINs), `profiles`, `school_admins`, and `school_requests` are **no longer anon-readable**. The remaining `using(true)` tables are the residual surface.

---

## 6. The published-fee lock trigger

`protect_published_class_fees()` — `20260707090000_fee_approval_workflow.sql:20-55`, `BEFORE UPDATE OR DELETE ... FOR EACH ROW`.

| Attempt on a row where `OLD.status='published'` | Result |
|---|---|
| `DELETE` | `raise exception` — "Published fees are locked … cannot be deleted" |
| `UPDATE` changing `status` away from published, or `amount`/`name`/`class_target`/`session_id`/`term_id`/`school_id` | `raise exception` — "… cannot be changed" |
| `UPDATE` `pending → published` | Allowed; auto-stamps `approved_at := coalesce(new.approved_at, now())` |
| Any change to a `pending` row | Allowed |

Because a trigger fires for **every** role, this is enforced against the service role too. Gotcha (documented in CLAUDE.md): a batch upsert from the Add Fee dialog aborts entirely if *any* row in the batch was published mid-edit — the dialog re-checks statuses server-side before upserting to avoid this.

---

## 7. Student PIN verification & lockout

`verify_student_pin(p_school_id uuid, p_student_id text, p_pin text)` — final definition in `20260707100000_fix_verify_student_pin_lockout.sql:29-91`, `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`. Called **only** from the `student-auth` edge function (service role, `student-auth/index.ts:64`), never from the browser.

**Backing columns** (added `20260707100000...:12-13`): `students.failed_login_attempts integer not null default 0`, `students.locked_until timestamptz`.

**Returns:** `id, student_id, name, class, school_id, session, term, must_change_pin` — an **empty result set means "invalid credentials or locked"** to the caller.

**Algorithm:**

| Step | Condition | Action |
|---|---|---|
| 1. Lookup | `school_id` = param, `upper(student_id)` = `upper(param)` (**case-insensitive**), `status <> 'inactive'`, `limit 1` | Load `id, pin, locked_until, failed_login_attempts` |
| 2. No match | `v_id is null` | `return` (empty) — invalid |
| 3. Locked | `locked_until is not null AND locked_until > now()` | `return` (empty) — **even a correct PIN is rejected while locked** |
| 4. Correct PIN | `v_pin = p_pin` | Reset `failed_login_attempts=0, locked_until=null`; return the student row |
| 5. Wrong PIN | else | `failed_login_attempts = v_attempts + 1`; if `v_attempts + 1 >= 5` → `locked_until = now() + interval '15 minutes'`; `return` (empty) |

So: **5 consecutive wrong PINs → 15-minute lockout**, during which even the correct PIN returns nothing; the counter resets on the next successful login. PIN comparison is **plaintext** (`v_pin = p_pin`), which is why the function must be `SECURITY DEFINER` (the anon caller can no longer `SELECT students.pin`).

**Gotchas / failure modes:**
- **Targeted DoS:** the lockout is keyed to the *student*, not the requesting IP. An attacker who knows a `student_id` can lock a legitimate student out with 5 bad guesses. There is no IP-level throttle.
- **Counter race:** two concurrent wrong-PIN requests can both read the same `v_attempts` before either writes, under-counting by up to the concurrency. Minor; the 5-strike gate still trips soon after.
- **Historical 500:** before this migration, `verify_student_pin` referenced `locked_until` which didn't exist → **every student login 500'd** with `record "v_student" has no field "locked_until"`. This migration is the fix; it drops every prior overload by `oid::regprocedure` because the return type changed (`20260707100000...:17-27`).
- **Inactive students** (`status='inactive'`) are excluded at lookup; `'archived'` students are **not** (the filter is only `<> 'inactive'`), so archived students may still authenticate. Verify this matches product intent.

---

## 8. Residual security debt

Explicit, code-observed debt still live in the schema/functions:

1. **Plaintext PINs.** `students.pin` is `text` and compared literally in `verify_student_pin`. Any school member can `SELECT` it (member SELECT policy). No hashing/salting. This is the single largest debt; anon read is closed but insider/DB-dump exposure remains.
2. **`schools` SELECT `using(true)` leaks settlement bank details.** `account_number`, `account_name`, `bank_name`, and `settings.paystack_subaccount_code` are readable by the public anon key for **every** school. Should be narrowed to the fields the portal actually needs pre-login (name, slug, logo) or split into a public view.
3. **`payments` SELECT `using(true)` is cross-tenant.** Any anon key holder can enumerate all payments (amount/reference/student_id) of all schools. Should be scoped to the requesting student/school.
4. **`payment_events` SELECT `using(true)` exposes raw webhook `payload` jsonb** to anon; also in the realtime publication.
5. **`fee_items` SELECT `using(true)`** — legacy table, still anon-readable cross-tenant (low impact; unused by the live flow).
6. **`reset_core_policies` skipped 5 tables.** `sessions`, `terms`, `payments`, `fee_items`, `payment_events` were never blanket-reset, so **old Lovable-era permissive policies could still be OR'ing in extra access on production**. These tables should get the same drop-all-then-recreate treatment to be certain of their live state.
7. **PIN lockout is per-student, no IP throttle** → targeted account-lock DoS (see §7).
8. **`class_fees` published rows are globally anon-readable** across tenants. Intended (fees shown pre-login) but allows enumeration of every school's fee schedule.

**Debts noted in CLAUDE.md that the code shows are now REMEDIATED** (CLAUDE.md's "Known issues" is stale here):
- ✅ `students` (incl. plaintext PIN) **no longer anon-readable** — closed by `20260707120000` + `20260707140000` (SELECT → `is_school_member`).
- ✅ `school_admins` **no longer anon-readable** — SELECT now requires `user_id=auth.uid()` OR membership.
- ✅ `ResetPassword.tsx` **no longer writes `students` from the browser** — it invokes the `student-set-pin` service-role function (`ResetPassword.tsx:61-69`).
- ✅ `add-bursar` **now verifies the caller owns the school** before inviting/adding (`add-bursar/index.ts:60-73`, returns 403 otherwise).

> NOTE: I did not exhaustively audit every one of the 14 edge functions for their own auth checks; §1.2/§8's "remediated" claims are based on `add-bursar`, `student-auth`, `student-set-pin`, and `register-school`. A reviewer should spot-check `change-pin`, `handle-school-request`, and `remove-bursar` for equivalent owner/ownership verification, since those also run as service role and thus bypass RLS.
