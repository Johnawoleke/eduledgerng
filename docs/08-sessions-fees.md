# 08 — Academic Periods & the Fee Approval Workflow

How EduLedgerNG models academic time (`sessions` → `terms` per school) and how fees move from a staff draft to a student-payable charge. This document covers the session/term selection engine (`useAcademicPeriods`), the ten **virtual future sessions** that gate the whole UI, and the `pending → published` fee-approval state machine with its immutability trigger. For the schema tables themselves see [02-data-model.md](02-data-model.md); for the RLS policies referenced here see [03-security-rls.md](03-security-rls.md); for how students consume published fees at checkout see [07-payments.md](07-payments.md) and [05-edge-functions.md](05-edge-functions.md).

> IMPORTANT: production was hand-rebuilt and drifted from the pre-2026-07 migrations. The live schema uses **`sessions`/`terms`**, NOT `academic_sessions`/`academic_terms`. RLS + the DB trigger are the enforcement floor because the untrusted browser talks straight to Postgres with the anon key. Everything below is cited against the live-reconciled code, not the archived migrations.

---

## 1. Data model recap (academic periods)

Two tables, both scoped to a school, defined in `supabase/migrations/20260706120000_baseline_live_schema.sql`.

### `sessions` (baseline L118–126)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `school_id` | `uuid` NOT NULL | FK → `schools(id)` `on delete cascade` |
| `name` | `text` NOT NULL | e.g. `"2026/2027"` |
| `is_current` | `boolean` | default `false` |
| `start_year` | `integer` | nullable |
| `end_year` | `integer` | nullable |
| `created_at` | `timestamptz` NOT NULL | default `now()` |

### `terms` (baseline L128–135)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `session_id` | `uuid` NOT NULL | FK → `sessions(id)` `on delete cascade` |
| `school_id` | `uuid` NOT NULL | FK → `schools(id)` `on delete cascade` (denormalized so term queries can `.eq("school_id", …)` directly) |
| `name` | `text` NOT NULL | e.g. `"Term 1"` |
| `is_current` | `boolean` | default `false` |
| `term_number` | `integer` | nullable; used for ordering and "Term 1" fallback |

**Cardinality:** one school → many sessions → (conventionally) three terms each. Seeding always creates `Term 1/2/3` with `term_number` 1/2/3 and `Term 1.is_current = true`.

> NOTE: neither `is_current` column is backed by a uniqueness constraint or trigger. Nothing at the DB level prevents two sessions (or two terms in one session) both having `is_current = true`. The selection logic (§3) copes by taking the *first* match, but a school that manually flips flags via SQL can produce a nondeterministic default. This is latent debt.

---

## 2. `useAcademicPeriods` — the period engine

File: `src/hooks/useAcademicPeriods.ts`. A single hook consumed by both `SchoolAdminDashboard.tsx` (L279) and `SchoolStudentDashboard.tsx` (L50). It owns all session/term state and exposes the derived option lists.

### 2.1 Type aliases (L5–6)

```ts
export type AcademicSession = Tables<"sessions">;
export type AcademicTerm    = Tables<"terms">;
```

These alias the generated Supabase row types, so the hook stays in sync with `src/integrations/supabase/types.ts` (hand-reconciled to the live schema).

### 2.2 Load sequence — `loadPeriods` (L60–119)

1. Guard: no `schoolId` → early return, `loading` stays true.
2. **Fetch sessions** (L64–72): `from("sessions").select("*").eq("school_id", schoolId)` ordered `start_year ASC (nullsFirst:false)` then `name ASC`.
3. **Empty-school safety seed (L80–106)** — runs only when `allSessions.length === 0 && !sessionsError`:
   - Inserts one session `{name: "<Y>/<Y+1>", start_year: Y, end_year: Y+1, is_current: true}` for the current calendar year.
   - On success inserts three terms (`Term 1` current, `Term 2`, `Term 3`) and re-fetches.
   - **This write requires an authenticated school member** (RLS insert policies on `sessions`/`terms`). For a logged-in student (anon key, not a member) the insert silently fails and the selectors stay hidden until staff seed periods. Comment at L77–79 documents this intentional no-op.
4. **Fetch terms (L110–117):** `from("terms").select("*").eq("school_id", schoolId)` ordered `term_number ASC`. Note: all terms for the school are loaded once, then filtered client-side per session.
5. `setLoading(false)`.

`reload` (returned as `reload: loadPeriods`, L189) lets callers re-pull after a mutation. `loadPeriods` is memoized on `schoolId` and driven by a `useEffect` (L121–123).

### 2.3 Default session selection (L126–140)

Runs once (`if (selectedSessionId || sessions.length === 0) return`):

| Priority | Rule |
|---|---|
| 1 | First session with `is_current === true` |
| 2 (fallback) | Sort by `start_year DESC`, tie-break `name.localeCompare DESC` → take `[0]` (the latest) |

### 2.4 Default term selection (L145–158)

Runs whenever `selectedSessionId` or `terms` change:

- If the selected session is **virtual/future** (`isFutureSessionId`) → `setSelectedTermId("")` and bail. This is critical: virtual sessions have no terms, and clearing prevents a stale term id from a prior real session leaking into period filters.
- Else filter terms to `t.session_id === selectedSessionId`, sort by `term_number`, then pick: `is_current` term → else `term_number === 1` → else `sessionTerms[0]`.

### 2.5 Derived values returned (L160–190)

| Returned key | Derivation | Purpose |
|---|---|---|
| `sessions` | raw DB rows | full real-session list |
| `terms` | raw DB rows (all school terms) | lookup pool |
| `sessionOptions` | real sessions `{id,name}` **+** `futureSessions` | what the dropdown renders |
| `isFutureSession` | `isFutureSessionId(selectedSessionId)` | the master gate flag |
| `selectedSessionId` / `selectedTermId` | state | current selection |
| `setSelectedSessionId` / `setSelectedTermId` | setters | |
| `termsForSelectedSession` | `[]` if future, else terms of that session sorted by `term_number` | term dropdown options |
| `selectedSession` | real match **?? future match** | display name (handles virtual ids) |
| `selectedTerm` | `terms.find(id === selectedTermId)` | display name |
| `loading` | state | |
| `reload` | `loadPeriods` | re-fetch |

---

## 3. Virtual future sessions

The dropdown shows real sessions **plus 10 upcoming virtual ones** that have **no DB rows**. This lets a school preview/select an upcoming year without letting anyone attach data to it.

### 3.1 Constants & id shape (L15–19)

| Constant | Value |
|---|---|
| `FUTURE_SESSION_COUNT` | `10` |
| `FUTURE_ID_PREFIX` | `"future-"` |
| `isFutureSessionId(id)` | `!!id && id.startsWith("future-")` |

A virtual id looks like `future-2027`, `future-2028`, … — **not a UUID**.

### 3.2 `buildFutureSessions(sessions, currentYear, count=10)` (L26–51)

1. Compute `lastEndYear`: start at `currentYear`, then for each real session derive its end year via `end_year ?? (start_year+1) ?? parse "YYYY/YYYY" from name` and keep the max.
2. Build a `Set` of existing session names (trimmed) to avoid collisions.
3. For `i` in `0..count-1`: `start = lastEndYear + i`, `name = "<start>/<start+1>"`, id `future-<start>`. **Skip any name that already exists as a real session** (`existingNames.has(name)`).

> NOTE: because the collision check `continue`s without incrementing a separate counter, when a generated name collides with a real session you get **fewer than 10** virtual entries in that render (the loop still only runs `count` iterations). Minor cosmetic quirk, not a correctness bug.

`futureSessions` is recomputed on every render (`buildFutureSessions(sessions, new Date().getFullYear())`, L161) — it is not memoized, but it is cheap.

### 3.3 Why virtual ids MUST gate every query and edit — the `22P02` hazard

A virtual id is a string like `future-2027`. Any Supabase filter that sends it to a `uuid` column (`session_id`, `term_id`) makes Postgres attempt `'future-2027'::uuid`, which fails with **`22P02 invalid input syntax for type uuid`**. So `isFutureSession` is used as a hard short-circuit *before* any query or edit path that would carry the session id to the DB. The gate appears in three layers:

**A. In the hook** — future sessions produce `selectedTermId = ""` (L147) and `termsForSelectedSession = []` (L170–174), so no term id is even available to send.

**B. In `SchoolAdminDashboard.tsx`** — every period-derived list is blanked and every mutating control disabled when `isFutureSession`:

| Location (line) | Behavior under a future session |
|---|---|
| `filteredClassFees` (L359–364) | `[]` |
| `publishedClassFees` (L367) | `[]` (derived from above) |
| `sessionClassFees` (L371–375) | `[]` → `pendingFeesCount` = 0 |
| `filteredPaymentsByPeriod` (L379–384) | `[]` |
| `totalStudents` (L1000) | `0` |
| `filteredStudents` (L1010) | blanked list |
| Upload CSV/Excel button (L1178) | `disabled` |
| Add Student button (L1188–1189) | `disabled` + tooltip "Upcoming sessions cannot be edited yet" |
| Add Fee button (L1210–1211) | `disabled` + same tooltip |
| Fees tab empty state (L1412–1414) | "This session hasn't started yet." |
| Students table empty cell (L1315) | future-session message |

**C. In `SchoolStudentDashboard.tsx`** (L88–91) — the fee/payment refresh effect returns early with `setStudentData([], [])` when `isFutureSession`, so the `student-auth` edge function is never even invoked with a virtual id.

Net effect: under a future session **both dashboards blank all lists and lock all edit actions**. The virtual id can never reach a `uuid` column.

---

## 4. Fee data model — `class_fees`

File defining the table: `supabase/migrations/20260706120000_baseline_live_schema.sql` L140–149, extended by `20260707090000_fee_approval_workflow.sql` (the approval columns) and `20260706130000_reconcile_live_schema.sql` (the upsert unique index).

| Column | Type | Source | Notes |
|---|---|---|---|
| `id` | `uuid` PK | baseline | |
| `school_id` | `uuid` NOT NULL | baseline | FK → `schools(id)` cascade |
| `class_target` | `text` NOT NULL | baseline | a class name (`"JSS1"`…) or the sentinel `"ALL"` (flat levy) |
| `name` | `text` NOT NULL | baseline | fee line item, e.g. `"Tuition Fee"` |
| `amount` | `numeric` NOT NULL | baseline | Naira |
| `session_id` | `uuid` (nullable) | baseline | period scope |
| `term_id` | `uuid` (nullable) | baseline | period scope |
| `created_at` | `timestamptz` NOT NULL | baseline | |
| `status` | `text` NOT NULL default `'published'` | approval migration L11 | `'pending'` \| `'published'` |
| `created_by` | `uuid` | approval migration L12 | auth uid of the staff who drafted it |
| `approved_by` | `uuid` | approval migration L13 | set by the owner on publish |
| `approved_at` | `timestamptz` | approval migration L14 | stamped by trigger/handler on publish |

> Existing rows defaulted to `'published'` on migration (L11) so nothing vanished for students already paying against pre-workflow fees.

### 4.1 The upsert unique key

Reconcile migration (`20260706130000_reconcile_live_schema.sql` L61–62):

```sql
create unique index if not exists class_fees_school_class_name_period_key
  on public.class_fees (school_id, class_target, name, session_id, term_id);
```

This is the `onConflict` target for the Add-Fee upsert (see §6). Before creating it, the migration **backs up and de-duplicates** existing rows: it copies duplicate groups (same 5-tuple, keeping the newest row per key by `created_at desc, id desc`) into `class_fees_duplicates_backup` and deletes them (L41–61), otherwise the unique index would fail to build.

> GOTCHA: `session_id`/`term_id` are nullable and part of a **unique index** (not a constraint). In Postgres, `NULL`s are distinct in a unique index, so legacy rows with null period columns are never deduped against each other and never conflict in the upsert. In practice every fee written by the current UI carries non-null `session_id`/`term_id` (the dialog requires both, L720), so this only affects pre-workflow legacy data.

---

## 5. The fee-approval state machine

Migration: `supabase/migrations/20260707090000_fee_approval_workflow.sql`.

```
            staff (owner OR bursar) creates
   [ none ] ─────────────────────────────────▶ [ pending ]
                                                  │   │
                        owner Approve & Publish    │   │  owner Reject
                        (update status)            │   │  (hard DELETE row)
                                                    ▼   ▼
                                             [ published ]   [ none ]
                                                    │
                                                    ▼
                                       LOCKED for the entire session
                                    (no edit, no delete, no un-publish —
                                     enforced even against service role)
```

| Transition | Who | Mechanism | Guard |
|---|---|---|---|
| ∅ → `pending` | owner **or** bursar | `INSERT` via upsert | RLS insert policy forces `status = 'pending'` |
| `pending` → `pending` (edit amount) | owner, or bursar on own school | `UPDATE`/upsert | RLS update policy; trigger allows (old status not published) |
| `pending` → `published` | **owner only** | `UPDATE status='published'` | RLS update policy (`is_school_owner`); trigger stamps `approved_at` |
| `pending` → ∅ (reject) | **owner only** | hard `DELETE` | RLS delete policy (`is_school_owner`) |
| `published` → *anything* | **nobody, ever** | blocked | `protect_published_class_fees` trigger raises exception |

### 5.1 The immutability trigger `protect_published_class_fees` (L20–55)

A `BEFORE UPDATE OR DELETE … FOR EACH ROW` trigger (L53–55). Logic:

- **DELETE:** if `old.status = 'published'` → `raise exception 'Published fees are locked for the session and cannot be deleted'`; otherwise allow (`return old`).
- **UPDATE of a published row:** rejected if the new row differs from the old in **any** of: `status`, `amount`, `name`, `class_target`, `session_id`, `term_id`, `school_id` (L32–42) → `raise exception 'Published fees are locked for the session and cannot be changed'`. In other words a published fee is fully frozen — including un-publishing it back to pending.
- **`pending` → `published`:** stamps `new.approved_at := coalesce(new.approved_at, now())` (L44–46).

**Critical property:** this is a database trigger, so it fires for **every** connection role, including the **service role** used by edge functions. There is no RLS bypass, no admin escape hatch — "published for the session" is a hard invariant. The only path back is a manual DBA `DROP TRIGGER` in the SQL editor.

> NOTE: "locked for the whole session" is enforced per-row (each published row is frozen), plus semantically the dialog surfaces published items as read-only across the class/term. There is no cross-row check that would, say, block editing a *pending* fee just because a *sibling* fee in the same session is published — locking is strictly row-level.

### 5.2 `is_school_owner(school_id_param)` (L61–72)

`security definer`, `stable`, `search_path=public`. Returns true if `auth.uid()` is either `schools.owner_id` **or** a `school_admins` row with `role = 'owner'`. Bursars (`school_admins.role = 'bursar'`) are members but **not** owners — so they can draft and edit pending fees but cannot publish or delete. Compare with the pre-existing `is_school_member` (baseline L202–213), which is true for *any* admin including bursars.

### 5.3 RLS policy split (L83–107) — replaces the old blanket `eduledger_class_fees_manage`

| Policy | Command | Predicate |
|---|---|---|
| `eduledger_class_fees_select` | SELECT | `status = 'published' OR is_school_member(school_id)` — everyone sees published fees (they're shown pre-login on the portal); members also see pending |
| `eduledger_class_fees_insert` | INSERT | `is_school_member(school_id) AND status = 'pending'` — members can only create drafts |
| `eduledger_class_fees_update` | UPDATE | `is_school_owner(school_id) OR (is_school_member(school_id) AND status = 'pending')` — owners can approve/edit; bursars edit only while pending. Same expression in both `using` and `with check`. |
| `eduledger_class_fees_delete` | DELETE | `is_school_owner(school_id)` — owners only (trigger still blocks deleting published rows) |

The migration `drop policy if exists eduledger_class_fees_manage` (L87) removes the older combined policy from the reconcile migration.

### 5.4 The `published`-only student filter lives in THREE places

Students must never see or pay a pending fee. There is no single chokepoint — the `status = 'published'` filter is duplicated in every student-facing read of `class_fees`:

| Function | File | Line |
|---|---|---|
| `student-auth` (fee summary) | `supabase/functions/student-auth/index.ts` | L92 `.eq("status", "published")` |
| `create-paystack-payment` (checkout total) | `supabase/functions/create-paystack-payment/index.ts` | L115 `.eq("status", "published")` |
| `create-zendfi-payment` (legacy) | `supabase/functions/create-zendfi-payment/index.ts` | (per CLAUDE.md — legacy, no longer in UI) |

> GOTCHA / DEBT: **any new student-facing read of `class_fees` must add `.eq("status","published")` itself.** The RLS select policy does *not* protect this — it lets members see pending rows, and the edge functions run as the **service role** (RLS bypassed entirely). The three-way duplication is the enforcement, and it is fragile. See [05-edge-functions.md](05-edge-functions.md).

---

## 6. Admin UI — Add Fee dialog & Fees tab

All in `src/pages/SchoolAdminDashboard.tsx`.

### 6.1 Dialog scaffolding & defaults

- Fee templates (`DEFAULT_FEE_TEMPLATES`, L52–55): `Tuition Fee, PTA Levy, Exam Fee, Sports Levy, Computer Fee, Library Fee, Laboratory Fee, Books and Materials, Uniform Fee, Development Levy` — ten fixed line items every dialog renders.
- Classes (`NIGERIAN_CLASSES`, L50): `JSS1, JSS2, JSS3, SSS1, SSS2, SSS3`, plus the `ALL` (flat levy) sentinel option.
- Dialog local state: `feeSessionId`, `feeTermId`, `feeClass`, `feeEntries[{name, amount, locked?}]`.
- Defaults sync from the dashboard selection (L282–289): the dialog's session/term seed from `academicPeriods.selectedSessionId/selectedTermId` (only if not already set).
- Term-options effect (L294–301): when the dialog session changes, keep a still-valid term else prefer the dashboard's term, else `"Term 1"`, else the first. `feeTermOptions` (L1047) = terms whose `session_id === feeSessionId`.

### 6.2 The stale-flag re-check (two-stage), and WHY

The trigger aborts the **entire upsert batch** if any row in it would touch a now-published fee. So the dialog defends against a fee being published in the Fees tab *while the dialog is open*:

**Stage 1 — refetch on open (L303–355).** The `fetchExistingFees` effect is keyed on `addFeeOpen` (among others), so **reopening the dialog always refetches**. For each of the 10 templates it finds any existing row and sets:
```ts
locked: existing?.status === "published"   // L337
```
Locked entries render a disabled input with a "Published — locked" badge (L1953, L1960–1967). Comment L303–306 explains: without the `addFeeOpen` key, a fee approved/rejected between opens would leave stale locked flags/amounts.

**Stage 2 — server re-check right before writing, inside `handleAddFee` (L717–790):**

1. Validate: `feeClass` required (L719); `feeSessionId && feeTermId` required (L720).
2. `validFees` = entries that are `!locked && name.trim() && Number(amount) > 0` (L723). If none → toast and abort (L724–727).
3. **Re-query current statuses** for that `(school_id, class_target, session_id, term_id)` (L735–741), build `publishedNames` set (L742–744), and drop any `validFees` whose name is now published → `writableFees` (L745). If `writableFees` is empty → toast "These fees were published in the meantime and are now locked.", close, `loadData()`, return (L746–751).
4. Build `upserts` — each row forced to `status: "pending"`, `created_by: userId` (L753–762).
5. **Upsert** with `onConflict: "school_id,class_target,name,session_id,term_id"` (L764–766) — matches the unique index from §4.1.
6. Success toast varies by role (owner reminded to approve in Fees tab; bursar told "submitted for owner approval"), notes any skipped published items (L771–777), resets the form, `loadData()` (L778–782).

> WHY the double guard: the `locked` flag (stage 1) is a UX affordance computed at open time; the server re-check (stage 2) is the correctness guard against the race where a sibling owner publishes mid-edit. Skipping the re-check would send a would-be update of a published row into the batch, the trigger would `raise`, and **all** other legitimately-pending fees in the same submit would be lost. The re-check trims the offenders so the rest still save.

> EDGE CASE: the two-stage guard covers same-name-published races. It does NOT cover a fee being published between the re-check `SELECT` (L735) and the `upsert` (L764) — a genuinely tiny TOCTOU window. If it hits, the trigger aborts the batch and `error.message` is toasted (L768–769); the user retries. Acceptable given the human-speed workflow.

### 6.3 Approve / Reject handlers

- **`handleApproveFee(feeId)`** (L793–806): `update({status:'published', approved_by: userId, approved_at: now()}).eq("id", feeId)`. Trigger also stamps `approved_at` if absent. Success toast: "Fee published! Students can now see and pay it. It is locked for this session." then `loadData()`. Errors surface via `error.message` (e.g. if RLS rejects a non-owner, or the trigger blocks a re-publish).
- **`handleRejectFee(feeId, feeName)`** (L808–819): `confirm()` prompt → hard `DELETE .eq("id", feeId)`. Only works on pending rows (owner-only via RLS; trigger blocks deleting published). Reject is destructive — **there is no soft "rejected" status**, the row is removed.

### 6.4 The Fees tab (L1386–1479)

- Title: `Fees for {selectedSession.name} (all terms)` (L1389). The tab is **session-wide, all terms** — deliberately, so a pending fee filed against a *different* term than the dashboard's current term is never invisible (comment L369–371).
- Data source `sessionClassFees` (L371–375): all `classFees` where `session_id === selectedSessionId` (blank if future session).
- Sorted by `class_target` then `name` (L1419).
- Columns: Class (`ALL` → "All Classes"), Fee Name, Term (looked up from `academicPeriods.terms`), Amount (`formatNaira`), Status badge, Actions.
- Status badge: green "Published" vs amber "Pending Approval" (L1431–1439).
- Actions cell (L1441–1470):
  - `pending` + `userRole === "owner"` → "Approve & Publish" button + a trash "Reject and remove" button.
  - `pending` + non-owner (bursar) → text "Awaiting owner".
  - `published` → text "Locked for session".
- **Pending badge on the tab trigger** (L1220–1224): `pendingFeesCount` (L376, count of pending in `sessionClassFees`) renders a red count badge so owners notice drafts awaiting approval.

### 6.5 What counts toward student balances (admin side)

Only **published** fees count. `filteredClassFees` (L359–364, by selected term) → `publishedClassFees` = those with `status==='published'` (L367). `getFeesForClass(studentClass)` (L387–391) returns published fees where `class_target === studentClass || class_target === "ALL"`. Per-student totals (L502–514) sum only these; the dashboard stat tiles (`totalFees`, `outstanding`, L1002–1003) derive from them. So a pending fee is completely invisible in balances/stats until published — consistent with the student view.

---

## 7. Cross-cutting scoping rules

- **Every fee is scoped to `(school_id, class_target, session_id, term_id)`.** The admin loads *all* fees for the school once (`loadData`, L463–466: `from("class_fees").select("*").eq("school_id", …)`) and filters by period client-side. The student edge function filters server-side by `session_id`/`term_id` if provided (`student-auth` L95–96).
- **Payments** carry `session_id`/`term_id` too (baseline `payments` L174–175) and are filtered the same way (`filteredPaymentsByPeriod`, L379–384). A fee and its payments must share a period to net against each other.
- **`class_target = "ALL"`** is a school-wide flat levy applied to every class in that period; it is unioned with the student's specific class in both the admin filter (L388–389) and the edge query (`.in("class_target", [student.class, "ALL"])`, `student-auth` L93).

---

## 8. Failure modes, edge cases & debt (quick reference)

| # | Scenario | Behavior / risk |
|---|---|---|
| 1 | Virtual `future-YYYY` id reaches a `uuid` column | Postgres `22P02`. Prevented by the `isFutureSession` gate in the hook + both dashboards (§3.3). If a new query path forgets the gate, it will crash. |
| 2 | Two sessions/terms both `is_current = true` | No DB uniqueness guard; selection takes the first found → nondeterministic default (§1 NOTE). |
| 3 | Empty school + student login | Auto-seed insert silently no-ops (RLS); selectors hidden until staff seed periods (§2.2). |
| 4 | New student-facing read of `class_fees` omits `.eq("status","published")` | Pending fees leak to students; RLS won't save you (edge funcs are service role). Three current call-sites duplicate the filter (§5.4). |
| 5 | Owner publishes a fee mid-edit in another tab | Stage-1 locked flag stale until dialog reopens; Stage-2 server re-check trims the offender so the rest of the batch still saves (§6.2). |
| 6 | TOCTOU between re-check SELECT and upsert | Trigger aborts the whole batch, `error.message` toasted, user retries (§6.2 EDGE CASE). |
| 7 | Attempt to un-publish, edit, or delete a published fee (any role, incl. service role) | Trigger raises; hard invariant, only escapable by manual `DROP TRIGGER` (§5.1). |
| 8 | Reject a pending fee | Hard DELETE — no audit trail, no "rejected" state, row is gone (§6.3). |
| 9 | Legacy fee rows with null `session_id`/`term_id` | Not deduped (NULLs distinct in unique index) and never conflict in upserts; harmless but can produce orphan rows outside any period filter (§4.1 GOTCHA). |
| 10 | `buildFutureSessions` name collision with a real session | That render shows <10 virtual sessions (§3.2 NOTE). Cosmetic. |
| 11 | Owner clicks Approve but is actually a bursar (spoofed client) | RLS update policy `is_school_owner` rejects; `error.message` toasted. UI already hides the button for non-owners (§6.4). |

---

## Related docs

- [02-data-model.md](02-data-model.md) — full table catalog (`sessions`, `terms`, `class_fees`, `payments`).
- [03-security-rls.md](03-security-rls.md) — the ~22-policy RLS surface, `is_school_member` vs `is_school_owner`.
- [05-edge-functions.md](05-edge-functions.md) — `student-auth`, `create-paystack-payment` and the published-only filter.
- [07-payments.md](07-payments.md) — how published fees drive the checkout total and split settlement.
- [11-limitations-constraints.md](11-limitations-constraints.md) — cross-cutting debt including the security items above.
