# 02 — Data Model

This is the permanent reference for EduLedgerNG's Postgres schema as it exists in the **live** database (Supabase project `ifonivphhfplntzshtsb`). The live schema was rebuilt by hand and drifted from the original Lovable migrations, so this document is grounded in the canonical migration chain (`supabase/migrations/20260706120000_baseline_live_schema.sql` → the six migrations after it) and the hand-reconciled `src/integrations/supabase/types.ts` (verified 2026-07-06), **not** the archived migrations. Because the untrusted browser talks to Postgres directly with the anon key, Row-Level Security is the enforcement floor for everything below — see **03-security-rls.md** for the policy deep-dive; this doc documents the tables, keys, triggers and enums that RLS sits on top of.

> NOTE: Nobody in this repo can run SQL against the live DB from here. Every "type/default/nullability" fact below comes from the migration DDL and `types.ts`. Where the two disagree, that divergence is called out explicitly — treat those as the highest-risk items to re-verify against `information_schema` on the live project.

---

## 1. Canonical sources & the migration chain

| Order | File | Applied where | What it does |
|---|---|---|---|
| 1 | `migrations/20260706120000_baseline_live_schema.sql` | Fresh projects (staging). **Prod already has this** — `migration repair --status applied` before any push. | Creates all 11 tables, `handle_new_user`, `is_school_member`, `verify_student_pin`, base RLS. |
| 2 | `migrations/20260706130000_reconcile_live_schema.sql` | Prod (pending, via SQL editor) + staging | Adds `payments.amount/reference/method/items`, `class_fees` unique index (+dedup backup), seeds sessions/terms, adds sessions/terms/class_fees/payments/school_requests RLS, backfills FKs. |
| 3 | `migrations/20260707090000_fee_approval_workflow.sql` | Prod + staging | Adds `class_fees.status/created_by/approved_by/approved_at`, the `protect_published_class_fees` trigger, `is_school_owner`, splits class_fees RLS. |
| 4 | `migrations/20260707100000_fix_verify_student_pin_lockout.sql` | Prod + staging | Adds `students.failed_login_attempts/locked_until`, rewrites `verify_student_pin` in plpgsql with lockout. |
| 5 | `migrations/20260707120000_harden_bursar_rls.sql` | Prod + staging | Adds `profiles.must_change_password`; tightens students/schools/school_admins/school_requests RLS. |
| 6 | `migrations/20260707140000_reset_core_policies.sql` | Prod + staging | Drops **all** policies on 6 sensitive tables and recreates only the canonical set (kills stray Lovable-era `using(true)` policies). |
| 7 | `migrations/20260707160000_students_no_delete.sql` | Prod + staging | Drops the students DELETE policy entirely — students are archived, never hard-deleted. |

`supabase/migrations-archive/*` describes the **abandoned** Lovable project (`eymbfxjnmvrhdxaorwcq`) and must never be applied. `src/integrations/supabase/types.ts` is hand-maintained and must be edited in lockstep with the schema.

---

## 2. Entity-relationship overview

```
                         auth.users (Supabase Auth)
                              │ 1:1 (id, ON DELETE CASCADE)
                              ▼
                          profiles ─────────────┐ (id = auth.uid)
                              │                  │ referenced by user_id/owner_id
                              │                  │ (NO FK — plain uuid columns)
         owner_id (uuid,no FK)│                  │
                              ▼                  │
   ┌──────────────────────  schools  ◄───────────┼──────────────┐
   │ 1:N            (id, slug UNIQUE)             │              │
   │        ┌──────────┼──────────┬───────────┬──┴────┐         │
   │        ▼          ▼          ▼           ▼        ▼         │
   │   school_admins  students  sessions   class_fees payments  │
   │   (role owner/    │  │        │ 1:N        │        │       │
   │    bursar,        │  │        ▼            │        │       │
   │    UNIQUE          │  │      terms         │        │       │
   │    school_id,      │  │   (session_id FK,  │        │       │
   │    user_id)        │  │    school_id no FK)│        │       │
   │                    │  │                    │        │       │
   │   school_requests  │  └── fee_items ◄──────┘ (legacy, per-student)
   │   (invitations,    │        ▲ student_id FK
   │    role,status,    │        │
   │    expires_at)     └────────┴── payments.student_id FK (ON DELETE CASCADE)
   │
   └── payment_events  (webhook audit log — NO FK to anything; payment_id is text)
```

Key structural facts:
- **`profiles.id` IS the auth user id** — there is no `user_id` column (the Lovable schema had one; the live one does not).
- Most "who owns this" links (`schools.owner_id`, `school_admins.user_id`, `students`↔session/term via text, `payments.session_id`) are **bare `uuid` columns with no foreign key**. Only `school_id` (and `terms.session_id`, `payments.student_id`, `fee_items.*`) are real FKs. This is deliberate drift — see §12.
- Every school-scoped table cascades on `schools.id` deletion.

---

## 3. `profiles`

Purpose: one row per authenticated admin/owner/bursar user, auto-created by a trigger on `auth.users` insert. `id` equals `auth.uid()`.

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | — | PK; **FK → `auth.users(id)` ON DELETE CASCADE**. Equals `auth.uid()`. |
| `full_name` | text | YES | — | From `raw_user_meta_data->>'full_name'` at signup. |
| `created_at` | timestamptz | NO | `now()` | |
| `email` | text | YES | — | Mirrored from `auth.users.email`. |
| `avatar_url` | text | YES | — | Unused by current UI (present for parity). |
| `must_change_password` | boolean | NO | `false` | Set true for owner-created bursars to force rotation of the temporary password on first login (migration 5). |

- **PK**: `id`. No other unique constraints or indexes beyond the PK.
- **Trigger `on_auth_user_created`** (on `auth.users`, AFTER INSERT, per row) → `handle_new_user()` (SECURITY DEFINER, `search_path=public`): inserts `(id,email,full_name)`, `ON CONFLICT (id) DO UPDATE SET email = excluded.email`. So re-signup/idempotent; full_name is **not** updated on conflict.
- Note: `types.ts` types `must_change_password` as a non-null boolean; both `avatar_url` and `must_change_password` are present columns on `profiles`.

---

## 4. `schools`

Purpose: one row per school **branch** — each has its own settlement bank account and (lazily) its own Paystack subaccount. One owner can register many.

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `owner_id` | uuid | NO | — | The creating user (`auth.uid`). **No FK.** Distinct from `school_admins` membership. |
| `name` | text | NO | — | School display name. |
| `slug` | text | YES | — | **UNIQUE**. URL slug for `/school/:slug/...`. Two live rows have `slug = NULL` and are unreachable (see §11). |
| `address` | text | YES | — | |
| `phone` | text | YES | — | |
| `email` | text | YES | — | |
| `school_code` | text | YES | — | Human short code (not the slug). |
| `bank_name` | text | YES | — | Resolved to a Paystack bank code on first payment. |
| `account_number` | text | YES | — | Settlement account; used to create the Paystack subaccount. |
| `account_name` | text | YES | — | |
| `created_at` | timestamptz | NO | `now()` | |
| `updated_at` | timestamptz | NO | `now()` | Not auto-updated by a trigger — app must set it. |
| `logo_url` | text | YES | — | |
| `status` | text | YES | `'active'` | Free-text; only `'active'` observed. No CHECK constraint. |
| `settings` | jsonb | NO | `'{}'::jsonb` | See §4.1. |

- **PK** `id`; **UNIQUE** `slug`. No other indexes in the DDL.
- Most-referenced table in the codebase (`.from("schools")` × 21).

> NOTE: `types.ts` types `slug` and `name` as non-null (`slug: string`) but the baseline DDL makes `slug` nullable with no default, and live data has NULL slugs. **The DDL/data is authoritative — `slug` is nullable.** This is a known type-vs-schema mismatch.

### 4.1 `schools.settings` JSONB

No schema change was made for Paystack; the subaccount code is cached inside `settings`:

| JSON key | Type | Written by | Meaning |
|---|---|---|---|
| `paystack_subaccount_code` | string | `create-paystack-payment` edge fn | Cached Paystack subaccount (`ACCT_...`) provisioned lazily on the first payment for that branch, from `bank_name`+`account_number`. Presence short-circuits re-provisioning. |

Everything about split settlement lives in **07-payments.md**; here it matters only as the reason `settings` exists and must stay `not null default '{}'`.

---

## 5. `school_admins`

Purpose: membership + role linking a user to a school. Owning a school (`schools.owner_id`) and being a member here are separate concepts — the owner is usually also an `owner`-role row here, but code checks both.

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `school_id` | uuid | NO | — | **FK → `schools(id)` ON DELETE CASCADE**. |
| `user_id` | uuid | NO | — | Member user (`auth.uid`). **No FK to profiles/auth.** |
| `created_at` | timestamptz | NO | `now()` | |
| `role` | text | NO | `'bursar'` | `'owner'` or `'bursar'`. No CHECK; convention only. |

- **PK** `id`; **UNIQUE `(school_id, user_id)`** — a user has at most one role per school.
- Writes (INSERT/UPDATE) happen **only** through service-role edge functions (`add-bursar`, `handle-school-request`); there is no INSERT/UPDATE RLS policy, so a member cannot self-escalate. Owners may DELETE members of their school (but not themselves) — see 03-security-rls.md.
- `is_school_member()` and `is_school_owner()` both read this table (see §13).

---

## 6. `school_requests`

Purpose: bursar invitations. An owner invites a user; the invitee accepts/declines via the `handle-school-request` edge function, which on accept inserts the `school_admins` row.

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `school_id` | uuid | NO | — | **FK → `schools(id)` ON DELETE CASCADE**. |
| `user_id` | uuid | NO | — | The invited user. |
| `requested_by` | uuid | NO | — | The inviting owner. |
| `role` | text | NO | `'bursar'` | Role to grant on accept (copied into `school_admins.role`). |
| `status` | text | NO | `'pending'` | See enum below. |
| `expires_at` | timestamptz | NO | — | No default; caller must set. Expiry checked in the edge fn. |
| `created_at` | timestamptz | NO | `now()` | |

- **PK** `id`. No unique constraint on `(school_id, user_id)` — duplicate pending invites are possible.
- **Status lifecycle** (managed entirely by `supabase/functions/handle-school-request/index.ts`):

| Status | Set when | Set by |
|---|---|---|
| `pending` | On creation (default) | `add-bursar` edge fn |
| `accepted` | Invitee accepts (also inserts `school_admins`, guarded by existing-member `maybeSingle` check) | `handle-school-request`, line 119 |
| `declined` | Invitee declines | `handle-school-request`, line 119 |
| `expired` | `now() > expires_at` at the moment the invitee tries to act | `handle-school-request`, line 80 |

- Gotcha: `expired` is **lazy** — a row stays `pending` in the DB until someone touches it after expiry; there is no cron/sweeper. A "pending" row can therefore be logically expired.
- Writes are service-role only (no INSERT/UPDATE/DELETE-via-app for status). RLS SELECT: invitee, inviter, or school owner; DELETE: inviter or owner (cancel).

---

## 7. `students`

Purpose: one row per enrolled student. **Students never use Supabase Auth** — they authenticate with `student_id` + a plaintext `pin` via `verify_student_pin` (SECURITY DEFINER). This table carries heavy drift: several redundant name columns and both text and uuid session/term references.

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `school_id` | uuid | NO | — | **FK → `schools(id)` ON DELETE CASCADE**. |
| `session_id` | uuid | YES | — | Intended FK to `sessions` — **no actual FK constraint**. |
| `full_name` | text | YES | — | Redundant with `name`/`surname`/`first_name`. |
| `class` | text | NO | — | e.g. `JSS1`. Matched against `class_fees.class_target`. |
| `status` | text | YES | `'active'` | See enum below. No CHECK. |
| `term_id` | uuid | YES | — | Intended FK to `terms` — no constraint. |
| `default_pin` | text | YES | — | The originally-issued PIN (for reset), distinct from `pin`. |
| `student_id` | text | NO | — | Login identifier (e.g. `OCD-1234`). Compared case-insensitively (`upper()`). |
| `surname` | text | YES | — | |
| `first_name` | text | YES | — | |
| `parent_email` | text | YES | — | |
| `must_change_pin` | boolean | YES | `true` | Forces PIN change flow after first login. Returned by `verify_student_pin` (coalesced to false). |
| `name` | text | NO | — | Primary display name (the column actually returned by auth). |
| `pin` | text | NO | — | **Plaintext 4-digit PIN.** Security debt (see §12). |
| `term` | text | YES | — | Text term label (e.g. `Term 1`) — the value `verify_student_pin` returns, NOT `term_id`. |
| `session` | text | YES | — | Text session label (e.g. `2026/2027`) — returned by auth, NOT `session_id`. |
| `is_first_login` | boolean | YES | `true` | Set at creation; cleared after first successful login flow. |
| `failed_login_attempts` | integer | NO | `0` | Added migration 4. Incremented on wrong PIN. |
| `locked_until` | timestamptz | YES | — | Added migration 4. Set to `now()+15min` after 5 consecutive failures. |

- **PK** `id`; **UNIQUE `(school_id, student_id)`** — student IDs are unique per school, not globally.
- **FK**: only `school_id`. `session_id`/`term_id` are dangling uuids; the text `session`/`term` columns are what auth and fee-matching actually use.
- **No DELETE policy** (dropped in migration 7): students cannot be hard-deleted via the API — only archived (`status` change). School deletion still cascades them away via the FK.
- **`status` enum** (free text, enforced only in app logic):

| Value | Meaning | Notable behavior |
|---|---|---|
| `active` | Enrolled/visible. Default. | Counted in dashboard totals. |
| `archived` | Soft-deleted. | `SchoolAdminDashboard.tsx:495` treats `archived`/`inactive` the same for filtering; set at `:568`. |
| `inactive` | Disabled. | **`verify_student_pin` blocks login** for `status='inactive'` (`coalesce(status,'active') <> 'inactive'`). NOTE: `archived` students can still log in — only `inactive` is gated in the RPC. |

- Gotcha: the `pin`/`default_pin` and the two name pairs (`name`+`full_name`, `surname`+`first_name`) are historically overlapping; the auth path reads `name`, `session`, `term`, `pin`, ignoring the `*_id` and `full_name` columns entirely.

---

## 8. `sessions` and `terms`

Purpose: academic periods per school. These are the **live** names; the archived schema called them `academic_sessions`/`academic_terms` with `start_date`/`end_date` DATE columns — see §12.

### `sessions`

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `school_id` | uuid | NO | — | **FK → `schools(id)` ON DELETE CASCADE** (added/backfilled in reconcile). |
| `name` | text | NO | — | e.g. `2026/2027`. |
| `is_current` | boolean | YES | `false` | Marks the active session. Not enforced-unique. |
| `start_year` | integer | YES | — | e.g. 2026. |
| `end_year` | integer | YES | — | e.g. 2027. |
| `created_at` | timestamptz | NO | `now()` | |

### `terms`

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `session_id` | uuid | NO | — | **FK → `sessions(id)` ON DELETE CASCADE**. |
| `school_id` | uuid | NO | — | **FK → `schools(id)` ON DELETE CASCADE** (backfilled in reconcile). |
| `name` | text | NO | — | e.g. `Term 1`. |
| `is_current` | boolean | YES | `false` | |
| `term_number` | integer | YES | — | 1/2/3. |

- Reconcile migration §3 **seeds** one current session (`<year>/<year+1>`) + three terms (Term 1 current, Terms 2/3 not) for any school lacking sessions.
- **Virtual future sessions**: the UI (`useAcademicPeriods.ts`, `buildFutureSessions`) synthesizes 10 upcoming sessions with ids `future-<year>` that are **not** in these tables. These ids are not UUIDs and will raise Postgres `22P02` if they reach any DB filter — `isFutureSession` must gate every query. This is app behavior, not a table fact, but it's the #1 data-model gotcha for queries against `sessions`/`class_fees`/`payments`.
- Gotcha: `types.ts` types `terms.session_id` as non-null and `sessions.*` correctly, matching DDL. `is_current` is nullable/`false` and there is **no uniqueness guarantee** that exactly one session/term is current — the app trusts, but the DB does not enforce, a single current period.

---

## 9. `class_fees`

Purpose: fee **definitions** per class + academic period. This is the table students actually pay against (via server-computed summaries), and the one governed by the approval workflow + immutability trigger.

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `school_id` | uuid | NO | — | **FK → `schools(id)` ON DELETE CASCADE**. |
| `class_target` | text | NO | — | Class the fee applies to (matched to `students.class`). |
| `name` | text | NO | — | Fee name (e.g. "Tuition"). |
| `amount` | numeric | NO | — | Fee amount (₦). |
| `session_id` | uuid | YES | — | Period scoping. Part of the upsert conflict key. No FK constraint (live). |
| `term_id` | uuid | YES | — | Period scoping. Part of the conflict key. |
| `created_at` | timestamptz | NO | `now()` | Tiebreaker in dedup (keep newest). |
| `status` | text | NO | `'published'` | Added migration 3. `pending`/`published`. **Default is `published`** so pre-existing rows stayed visible; new inserts are forced to `pending` by RLS. |
| `created_by` | uuid | YES | — | User who created the fee. |
| `approved_by` | uuid | YES | — | Owner who published it. |
| `approved_at` | timestamptz | YES | — | Auto-set by the trigger on pending→published. |

- **PK** `id`.
- **UNIQUE INDEX `class_fees_school_class_name_period_key`** on `(school_id, class_target, name, session_id, term_id)` (reconcile §2). This backs the Add/Update Fee **upsert** (`onConflict "school_id,class_target,name,session_id,term_id"`). Before it existed, the old flow inserted duplicates (double-counting fee totals).
- **`class_fees_duplicates_backup`** (see §10) holds the rows removed to make that unique index buildable.
- **`status` enum**:

| Value | Meaning | Who sets it |
|---|---|---|
| `pending` | Draft fee, invisible to students. | Owners AND bursars create fees — RLS INSERT forces `status='pending'`. |
| `published` | Live, payable, and **immutable for the session**. | Only owners (`is_school_owner`) may transition pending→published (RLS UPDATE). |

- **Trigger `protect_published_class_fees`** (BEFORE UPDATE OR DELETE, per row; `protect_published_class_fees()` plpgsql, **not** SECURITY DEFINER so it runs in caller context but its RAISE fires for everyone including the service role):
  - DELETE of a `published` row → `raise exception` (blocked).
  - UPDATE of a `published` row that changes `status` away from published, or `amount`/`name`/`class_target`/`session_id`/`term_id`/`school_id` → `raise exception` (blocked). Only a no-op update of a published row is allowed.
  - On `pending → published`, sets `approved_at := coalesce(new.approved_at, now())`.
  - Net: the **only** legal mutation of a published fee is the publish transition itself. Published fees are locked for the whole session even against the service role.
- Gotcha (documented in CLAUDE.md): a single upsert **batch** aborts entirely if any row in it hits a published fee, so the Add Fee dialog refetches + re-checks statuses server-side before upserting.
- Student-facing filter: **every** read that students can trigger (`student-auth`, `create-paystack-payment`, legacy `create-zendfi-payment`) filters `status='published'`. RLS also enforces it (SELECT allows non-members only published rows), but the belt-and-suspenders app filter must be added to any new student-facing read.

---

## 10. `class_fees_duplicates_backup`

Purpose: reversible parking lot for `class_fees` rows deleted during dedup so the unique index could be built (reconcile §2).

- Created `LIKE public.class_fees` **at the time of the reconcile migration** — i.e. it has the class_fees columns that existed *then* (`id, school_id, class_target, name, amount, session_id, term_id, created_at`) but **NOT** the later `status/created_by/approved_by/approved_at` columns (added in migration 3, which runs afterward). `LIKE` does not copy PK/unique/FK constraints, only column defs + NOT NULL + defaults.
- RLS **enabled** but **no policies** → effectively no anon/authenticated access (deny-all); only the service role can read it.
- Dedup logic: `row_number() over (partition by school_id,class_target,name,session_id,term_id order by created_at desc, id desc)`; rows with `rn > 1` are deleted from `class_fees` and inserted here. Newest row per key survives.
- This is a one-shot forensic/rollback artifact (`supabase/rollback/`), not part of any live query path.

---

## 11. `fee_items`

Purpose: **legacy** per-student fee instances. Retained for parity; nothing in the active UI relies on it (the `student-payment`/Zendfi legacy pair touched it). Live fee summaries are computed from `class_fees` minus `payments`, not from this table.

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `student_id` | uuid | NO | — | **FK → `students(id)` ON DELETE CASCADE**. |
| `school_id` | uuid | NO | — | **FK → `schools(id)` ON DELETE CASCADE**. |
| `name` | text | NO | — | Fee name. |
| `amount` | numeric | NO | — | Total owed. |
| `paid` | numeric | NO | `0` | Amount paid so far. |
| `status` | text | NO | `'unpaid'` | Free text (`unpaid`/…); not part of any enforced enum. |
| `created_at` | timestamptz | NO | `now()` | |

- RLS: SELECT `using(true)` only (baseline). No app-level INSERT/UPDATE policy → writes only via service role. `.from("fee_items")` appears only twice in the codebase.

---

## 12. `payments`

Purpose: the ledger of settled/recorded payments. Baseline created a thin version; the reconcile migration bolted on the columns the live payment code needs. **Two amount columns coexist** (`amount` new, `amount_paid` legacy).

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `school_id` | uuid | NO | — | FK → `schools(id)` (backfilled in reconcile §5; ON DELETE CASCADE). |
| `student_id` | uuid | NO | — | **FK → `students(id)` ON DELETE CASCADE**. |
| `date` | timestamptz | NO | `now()` | Payment date (default re-asserted in reconcile). |
| `session_id` | uuid | YES | — | Period scoping. No FK. |
| `term_id` | uuid | YES | — | Period scoping. No FK. |
| `created_at` | timestamptz | NO | `now()` | |
| `amount_paid` | numeric | YES | — | **Legacy** amount column. Backfilled into `amount` once; not written going forward. |
| `amount` | numeric | NO | `0` | Canonical amount (reconcile §1). Code writes this. |
| `reference` | text | YES | — | Gateway reference; idempotency key. |
| `method` | text | YES | — | e.g. `paystack`, `zendfi`, `manual`. |
| `items` | text[] | NO | `'{}'` | Which fee line-items this payment covers. |

- **PK** `id`.
- **Partial UNIQUE INDEX `payments_reference_key`** on `(reference) WHERE reference IS NOT NULL` (reconcile §1). This is the idempotency guarantee for the webhook + verify paths (a reference is recorded at most once even if webhook and redirect both fire). Multiple NULL-reference rows are allowed (legacy/manual).
- **FK**: `student_id` (always), `school_id` (backfilled). `session_id`/`term_id` are dangling uuids.
- Reconcile backfill: `update payments set amount = amount_paid where amount = 0 and amount_paid is not null` — one-time. After this, `amount_paid` is dead weight; prefer `amount` everywhere. Gotcha: any pre-reconcile row whose real amount was genuinely `0` is indistinguishable, and a NULL `amount_paid` leaves `amount=0`.
- RLS: SELECT `using(true)` (student dashboard reads with anon key). **All writes go through service-role edge functions** — there is no INSERT/UPDATE policy, so the anon browser cannot forge a payment.
- Payment mechanics (gross-up, split, verification) are out of scope here — see **07-payments.md**.

---

## 13. `payment_events`

Purpose: webhook audit log + realtime feed for the dashboard. Deliberately **decoupled** from `payments` (no FK; `payment_id` is text).

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | PK. |
| `event_type` | text | YES | — | e.g. `charge.success`. |
| `payment_id` | text | YES | — | Gateway payment id / reference. **text, no FK** to `payments`. |
| `status` | text | YES | — | Event status. |
| `amount_usd` | numeric | YES | — | Historical/Zendfi-era field (name says USD; NGN in practice). |
| `payload` | jsonb | YES | — | Raw webhook body. |
| `created_at` | timestamptz | NO | `now()` | |

- **PK** `id`. No unique constraint (webhooks can be logged multiple times).
- Added to publication `supabase_realtime` (baseline `do $$ … add table … exception when others then null $$`) so the UI can subscribe live.
- RLS: SELECT `using(true)`; writes service-role only.
- Gotcha: `amount_usd` is a misnomer carried from the Zendfi era; it is not currency-normalized.

---

## 14. Historical drift (why the archive differs)

The live DB was rebuilt by hand in 2026-04 when the project left the Lovable-managed tenant (`eymbfxjnmvrhdxaorwcq` → `ifonivphhfplntzshtsb`). Key divergences the archived migrations still show but that are **wrong for live**:

| Concept | Archived / Lovable schema | Live schema (authoritative) |
|---|---|---|
| Academic periods | `academic_sessions` / `academic_terms`, with `start_date`/`end_date` DATE columns and FK'd `class_fees.session_id → academic_sessions` | `sessions` / `terms`, with `start_year`/`end_year` INTEGER; class_fees session/term are unconstrained uuids |
| Profile identity | `profiles.user_id` column linking to auth | **No `user_id`** — `profiles.id` **is** the auth uid |
| Per-student fees | `student_fees` table (referenced conceptually) | **No `student_fees` table**; `fee_items` is the vestigial per-student table, and summaries are computed from `class_fees − payments` server-side |
| Students | Fewer columns | Extra columns: `is_first_login`, `surname`, `first_name`, `session_id`, `default_pin`, `parent_email`, plus lockout columns |
| Term/session on students | (n/a) | Both text (`session`/`term`, used by auth) **and** uuid (`session_id`/`term_id`, mostly unused) |

The code (`.from(...)` calls) and `types.ts` all reference the **live** names. The archive exists for history only and must never be applied (see `migrations-archive/README.md`). Practical impact: grepping old migrations for schema truth will mislead you — always trust `migrations/20260706120000…` onward + `types.ts`.

---

## 15. Functions used by RLS / edge functions

| Function | Lang / security | Signature | Purpose |
|---|---|---|---|
| `handle_new_user()` | plpgsql, SECURITY DEFINER, `search_path=public` | trigger | Auto-creates `profiles` row on `auth.users` insert (upsert on id). |
| `is_school_member(school_id_param uuid)` | sql, STABLE, SECURITY DEFINER | → boolean | True if `auth.uid()` is the school's `owner_id` OR any `school_admins` row for that school. Used across RLS. |
| `is_school_owner(school_id_param uuid)` | sql, STABLE, SECURITY DEFINER | → boolean | True if `auth.uid()` is `owner_id` OR a `school_admins` row with `role='owner'`. Gates publishing, student edits/deletes, bank-detail edits. |
| `verify_student_pin(p_school_id uuid, p_student_id text, p_pin text)` | plpgsql (post-migration 4), SECURITY DEFINER, `search_path=public` | → table(id, student_id, name, class, school_id, session, term, must_change_pin) | Student login. Case-insensitive `student_id`; excludes `status='inactive'`; enforces 5-strike / 15-min lockout via `failed_login_attempts`/`locked_until`; returns **no rows** on bad/locked (caller treats empty = invalid). |

Notes / gotchas on the functions:
- `verify_student_pin` was **redefined** in migration 4 because the **drifted production** `verify_student_pin` (hand-built, differing from the file) referenced `locked_until` before the column existed, 500-ing every login — the plain-SQL **file** version in the baseline never referenced `locked_until`. The baseline file's definition is now superseded — migration 4's plpgsql version is live. It drops **all** overloads by name first (return-type change blocks CREATE OR REPLACE).
- `is_school_member`/`is_school_owner` are SECURITY DEFINER so they can read `schools`/`school_admins` regardless of the caller's RLS — this is what lets policies reference membership without recursive RLS.
- The `Functions` block in `types.ts` (lines 495–511) mirrors these three signatures.

---

## 16. Constraints, indexes & triggers — consolidated

| Object | On table | Type | Definition / effect |
|---|---|---|---|
| `profiles_pkey` | profiles | PK | `id` (also FK → auth.users, CASCADE) |
| `schools_pkey` / `schools_slug_key` | schools | PK / UNIQUE | `id` / `slug` |
| `school_admins_pkey` / unique | school_admins | PK / UNIQUE | `id` / `(school_id, user_id)` |
| `school_requests_pkey` | school_requests | PK | `id` |
| `students_pkey` / unique | students | PK / UNIQUE | `id` / `(school_id, student_id)` |
| `sessions_pkey` | sessions | PK | `id` |
| `terms_pkey` | terms | PK | `id` |
| `class_fees_pkey` | class_fees | PK | `id` |
| `class_fees_school_class_name_period_key` | class_fees | UNIQUE INDEX | `(school_id, class_target, name, session_id, term_id)` — backs the upsert |
| `fee_items_pkey` | fee_items | PK | `id` |
| `payments_pkey` | payments | PK | `id` |
| `payments_reference_key` | payments | UNIQUE INDEX (partial) | `(reference) WHERE reference IS NOT NULL` — idempotency |
| `payment_events_pkey` | payment_events | PK | `id` |
| `on_auth_user_created` | auth.users | TRIGGER | AFTER INSERT → `handle_new_user()` |
| `protect_published_class_fees` | class_fees | TRIGGER | BEFORE UPDATE OR DELETE → immutability of published fees |

FKs with `ON DELETE CASCADE` to `schools(id)`: `school_admins`, `school_requests`, `students`, `sessions`, `terms`, `class_fees`, `fee_items`, `payments` (backfilled). FK to `sessions(id)`: `terms.session_id`. FK to `students(id)`: `fee_items.student_id`, `payments.student_id`. FK to `auth.users(id)`: `profiles.id`.

---

## 17. Assumptions, limitations, failure modes & debt

**Assumptions the schema bakes in**
- Exactly one `is_current` session/term per school — **not enforced** by any constraint; the app assumes it.
- `student.class` strings match `class_fees.class_target` strings exactly (both free text). A typo silently yields zero fees for a class.
- Text `session`/`term` on students are the join keys for auth/fee display, not the uuid `*_id` columns.

**Limitations / constraints**
- No CHECK constraints on any `status`/`role`/`method` column — all enums are convention enforced in app/RLS only; the DB will accept arbitrary strings.
- `session_id`/`term_id` on `students`, `class_fees`, `payments` are unconstrained uuids — nothing prevents a fee/payment pointing at a session from another school, or at a non-existent session.
- `payment_events.payment_id` is text with no FK — audit rows can dangle.

**Failure modes**
- Virtual `future-<year>` session ids reaching any DB filter → Postgres `22P02` (invalid uuid). Must be gated by `isFutureSession`.
- Upsert batch touching a published fee → the `protect_published_class_fees` trigger raises and aborts the **whole** batch (mitigated by the dialog's pre-check).
- `verify_student_pin` referencing a missing column (the pre-migration-4 production-drift bug) → 500 on every login. Any future edit to that function must keep the column set consistent.
- Duplicate `class_fees` (pre-reconcile) → double-counted student balances; fixed by dedup + unique index but the backup table's rows are not reconciled back.

**Security debt (see 03-security-rls.md for the full picture)**
- `students.pin` is **plaintext**; `default_pin` too. Reads are now member-scoped (migration 5/6) but the values are unhashed at rest.
- Most identity links (`owner_id`, `user_id`, `session_id`, `term_id`) are FK-less uuids — no referential integrity, orphan rows possible.
- `amount_paid` is dead but retained; a stray reader could sum the wrong column. Prefer `amount`.
- `schools.slug` can be NULL (two live rows), making those schools unreachable via `/school/:slug` despite `types.ts` typing it non-null.

**Cross-references**: RLS policy matrix → 03-security-rls.md; edge functions & `verify_student_pin` auth flow → 04-auth (student/admin); Paystack split settlement & `settings.paystack_subaccount_code` & `payments` write path → 07-payments.md.
