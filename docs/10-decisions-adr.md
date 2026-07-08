# Architecture Decision Records (ADRs)

Each record captures a significant decision, the context, the choice, and the trade-off accepted. Newest decisions build on older ones. Status: **Accepted** unless noted.

---

## ADR-001 — Hardcode the Supabase URL + anon key in the bundle

**Context.** The owner deploys on Vercel and is not comfortable configuring environment variables. The two values are the Supabase project URL and the *anon (publishable)* key — both public by design; they ship in the frontend JS to every browser regardless.

**Decision.** Hardcode them in `src/integrations/supabase/client.ts`. Provide a `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` override used *only* for local dev pointed at staging.

**Trade-off.** Config-free Vercel deploys and no chance of a missing-env outage, at the cost of the values being visible in the bundle (acceptable — they are public and RLS is the actual security boundary). Service-role keys and Paystack/Zendfi secrets are **never** hardcoded — they are edge-function secrets. See `notes/supabase-env-vars.md`.

---

## ADR-002 — No backend server; the browser talks directly to Supabase

**Context.** The app was scaffolded (by Lovable) to use `supabase-js` directly from React for most CRUD.

**Decision.** Keep the direct-access pattern. Put *privileged/complex* logic in Deno **edge functions** (service role) and *authorization* in **RLS policies**.

**Trade-off.** Fast to build and no server to run, but it means **the UI can enforce nothing** — every rule that matters must be an RLS policy or an edge-function caller check, because the anon key and all client code are attacker-visible. This is the single most important architectural fact; it drives ADR-006. An alternative (route everything through edge functions and lock the DB entirely) was considered and rejected as a large rewrite for this stage. See `01-architecture.md`, `03-security-rls.md`.

---

## ADR-003 — Students authenticate by PIN, server-side; they are not Supabase Auth users

**Context.** Students are numerous, transient, and identified by a school-issued `student_id` + short PIN, not email/password.

**Decision.** Keep students out of Supabase Auth. Verify `student_id` + PIN in the `verify_student_pin` RPC, called only by service-role edge functions (`student-auth`, `change-pin`, `student-set-pin`, payment functions). The student "session" is app state in `localStorage` (`pity_*`), with credentials re-sent to functions for privileged actions.

**Trade-off.** Simple for schools and avoids an auth account per student, but PINs are short and (see ADR-007) currently stored in plaintext; brute-force is mitigated by a 5-strike / 15-minute server-side lockout. Because students hold no JWT, RLS cannot identify "this student updating their own row" — so all student writes must go through service-role functions (see ADR-008).

---

## ADR-004 — The live schema (`sessions`/`terms`), not the migration files, is the source of truth

**Context.** When the project moved off the abandoned Lovable-managed Supabase tenant onto the owner's personal project, the database was **rebuilt by hand** and diverged from the committed migrations (e.g. it uses `sessions`/`terms`, not the `academic_sessions`/`academic_terms` in the old migrations; different `students`/`profiles`/`payments` columns).

**Decision.** Treat the live database as canonical. `src/integrations/supabase/types.ts` is hand-maintained against it. Old migrations were moved to `supabase/migrations-archive/` (never re-apply). A `baseline_live_schema` migration recreates the live schema for fresh environments; a `reconcile_live_schema` migration repairs prod drift.

**Trade-off.** The repo no longer double as an executable history of prod, but it stops the migrations from lying about reality. This drift caused real production incidents (the `verify_student_pin` 500; two rounds of stray permissive policies) — documented in `11-limitations-constraints.md`.

---

## ADR-005 — Fees require owner approval and are immutable once published

**Context.** Bursars do fee data-entry, but publishing a fee to students (and thus what they owe) is an owner-level financial decision, and a published fee must not silently change mid-session.

**Decision.** `class_fees.status` is `pending` → `published`. Members create only `pending` fees (RLS `with check status='pending'`); only owners publish (RLS `is_school_owner`). A `BEFORE UPDATE/DELETE` trigger (`protect_published_class_fees`) makes published rows immutable for the whole session — **even to the service role**. Students only ever read/pay `published` fees, enforced in every payment path.

**Trade-off.** Strong integrity and a clear audit line, at the cost of no in-place correction of a published fee within a session (by design). See `08-sessions-fees.md`.

---

## ADR-006 — Authorization is enforced in RLS/edge functions, not the UI

**Context.** A security audit found the UI merely *hid* owner-only actions (delete student, reset PIN, change bank account, add bursar) while the database still allowed a bursar's token to perform them directly.

**Decision.** Push every role restriction into RLS (`is_school_member` / `is_school_owner`) and give each privileged edge function an explicit caller check. The UI keeps hiding buttons for UX, but is never the enforcement point. Reads and writes were scoped: `students` read/insert = member, update/delete = owner; `schools` update = owner; `handle-school-request` verifies the caller is the invitee; `remove-bursar` verifies owner.

**Trade-off.** More policies to reason about (this is *why there are "so many"* — they are the enforcement, not overhead), but the visible UI and the actual authority finally match. See `03-security-rls.md`.

---

## ADR-007 — Student PINs remain plaintext (known debt)

**Context.** `verify_student_pin` compares `students.pin` directly, and admin flows read/write it. Hashing would require reworking those flows.

**Decision (interim).** Keep plaintext PINs for now, but **close the exposure**: `students` SELECT is now school-member-only (previously `using(true)`, which let the anon key dump every PIN), and a 5-strike/15-minute lockout limits brute force.

**Trade-off.** Lower implementation cost now; residual risk that a school owner/bursar (or a DB-level compromise) can read PINs. Hashing PINs is a tracked follow-up. See `11-limitations-constraints.md`.

---

## ADR-008 — Student self-service PIN changes go through edge functions

**Context.** First-login PIN reset originally wrote to `students` directly from the browser with the anon key, which forced the `students` UPDATE policy to be wide open.

**Decision.** Move first-login reset into the `student-set-pin` edge function (verifies the current PIN, writes via service role). This let `students` UPDATE be locked to owners.

**Trade-off.** One more function and a round-trip, in exchange for removing all anon write access to student rows.

---

## ADR-009 — 10 future sessions are *virtual* (dropdown-only), not database rows

**Context.** Users want to see/plan upcoming academic sessions, but pre-creating rows invites junk data (a prod bug had already created 11 stray `sessions` rows for one school) and premature editing.

**Decision.** `buildFutureSessions` synthesizes the next 10 sessions with ids `future-<year>` and **no DB rows**. Selecting one blanks and disables every edit path in both dashboards (`isFutureSession`), because a virtual id is not a UUID and would raise `22P02` if it reached a DB filter.

**Trade-off.** Future sessions can't hold data until naturally created, which is exactly the point ("blank and non-editable"). Every query/edit site must respect `isFutureSession`. See `08-sessions-fees.md`.

---

## ADR-010 — Students are archived, never deleted

**Context.** A removed student would orphan payment/fee history and is irreversible.

**Decision.** Replace hard delete with **archive** (`status='archived'`, owner-only, reversible via restore). The `students` DELETE RLS policy was dropped entirely, so no client — owner, bursar, or anon — can hard-delete a student via the API. Archived students are hidden from the active roster/stats but fully retained and restorable.

**Trade-off.** `students` rows accumulate over time (acceptable), in exchange for a permanent, auditable record. See `06-user-workflows.md`.

---

## ADR-011 — Paystack split settlement with a per-school subaccount; the student bears the gateway fee

**Context.** Each school (branch) must receive its own students' fees directly, minus a flat 1% platform cut, without manual payouts.

**Decision.** Lazily provision one Paystack **subaccount** per school from its registered bank details (cached in `settings.paystack_subaccount_code`). Each transaction is a split: a flat 1%-of-fees `transaction_charge` to the platform, the remainder to the school subaccount (`bearer: "subaccount"`). The checkout total is **grossed up** so the parent covers Paystack's processing fee on top.

**Superseded by ADR-013** on the fee/charge split: originally the platform 1% was deducted from the fee (school netted 99%). See below.

**Trade-off.** Schools get automatic direct settlement per branch and the platform gets a clean 1%. The gross-up formula is duplicated in `create-paystack-payment` and `SchoolStudentDashboard.tsx` and **must be kept in sync**. See `07-payments.md`.

---

## ADR-013 — The school receives the exact fee; both charges are added on top

**Context.** The founder's model (2026-07-08): EduLedgerNG is a record-management/ledger tool, so a school must receive the **precise** amount it set for a fee — like a paper ledger. Both the Paystack gateway charge **and** the platform charge are **added on top** and borne by the parent, never deducted from the school's fee. Supersedes the original ADR-011 split (where the 1% was taken out of the fee and the school netted 99%).

**Decision.** Gross the checkout up on **base + platform_fee** (not just base), so after Paystack's fee clears, the settled amount is `fee + 1%`; the split's `transaction_charge` (1%) goes to the platform and the subaccount receives exactly the **full fee**. Net: `parent pays = fee + platform 1% + Paystack fee`; `school receives = fee (100%)`; `platform keeps = 1%`. The recorded `payments` still store only the base fee amounts, so the school's ledger reflects the exact fees. Worked example (₦50,000 fee): parent pays ≈ ₦51,370.56 = ₦50,000 + ₦500 + ≈₦870.56; school receives ₦50,000.

**Trade-off.** Parents pay marginally more (they now also carry the 1%), in exchange for the school's records and settlement being exact — which is the product's core promise. The two-line gross-up target change lives in both `create-paystack-payment` and `SchoolStudentDashboard.tsx` and must stay in sync.

---

## ADR-012 — Paystack replaces Zendfi in the UI; Zendfi code retained as legacy

**Context.** An earlier Zendfi (crypto on-ramp) integration existed but never reliably recorded payments (the prod `payments` table was missing columns).

**Decision.** Make Paystack the only payment option in the UI. Leave `create-zendfi-payment`, `zendfi-webhook`, and `student-payment` in the repo as legacy (still deployed, not invoked by the frontend).

**Trade-off.** Some dead code remains, but removing deployed functions risks breaking any external caller; they are clearly marked legacy. See `05-edge-functions.md`.
