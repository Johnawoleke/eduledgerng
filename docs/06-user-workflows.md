# 06 — User Workflows (End to End)

This document traces every user-facing workflow in EduLedgerNG as numbered step-by-step sequences, naming the exact page component, edge function, RPC, or DB trigger involved at each step, plus who may perform it, its preconditions, and what blocks it. It is written against the **actual code** (frontend `src/pages/*`, edge functions in `supabase/functions/*`, and the live-schema migrations), not the archived Lovable migrations. For the schema and RLS enforcement floor these flows sit on top of, see `01-architecture.md` and the security/RLS doc; for the payment money-model math see the payments doc.

> NOTE: There are two auth systems (see `01-architecture.md`): **admins/owners/bursars** use real Supabase email+password auth; **students** use `student_id` + PIN validated only server-side by edge functions. Every "privileged" student action re-sends the student's credentials to an edge function because there is no student JWT.

## 0. Route map (from `src/App.tsx`)

| Path | Component | Audience |
|---|---|---|
| `/register` | `RegisterPage` (imported as `Register`) | New admin/owner |
| `/register-school` | `RegisterSchool` | Signed-in owner |
| `/login`, `/owner-login` | `OwnerLogin` | Owner/bursar |
| `/main-dashboard` | `Dashboard` | Owner/bursar (multi-school hub) |
| `/change-password` | `ChangePassword` | Owner/bursar (also forced-rotation) |
| `/account-recovery` | `AccountRecovery` | Owner (email reset link target) |
| `/school/:slug` | `SchoolPortal` | Student **and** admin login entry |
| `/school/:slug/admin/*` | `SchoolAdminDashboard` | Owner/bursar |
| `/school/:slug/settings` | `SchoolSettingsPage` | Owner only (button gated) |
| `/school/:slug/student/*` | `SchoolStudentDashboard` | Student |
| `/school/:slug/reset-password` | `ResetPassword` | Student (forced first-login PIN set) |
| `/school/:slug/change-pin` | `ChangePinPage` | Student (voluntary PIN change) |
| `/school/:slug/receipt/:paymentId` | `ReceiptPage` | Student/admin |

> NOTE: Routing is declarative only — there are **no route guards**. Each page self-checks auth in a `useEffect`/`loadData` and redirects on failure. A user who types `/school/:slug/admin` while signed out is bounced back to `/school/:slug` by `loadData` in `SchoolAdminDashboard.tsx` (lines 414-418), not by the router.

---

## 1. Owner sign-up + school registration

**Who:** anyone (self-service). **Precondition:** none. **Result:** a Supabase auth user, a `profiles` row, a `schools` row, a `school_admins` row with `role = 'owner'`, and a seeded current session + 3 terms.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | User fills Full Name / Email / Password (min 6 chars) and submits | `src/pages/RegisterPage.tsx` `handleRegister` (L20-54) | Client-side `supabase.auth.signUp({ email, password, data:{ full_name } })` — **uses the browser anon client, not an edge function**. |
| 2 | DB trigger creates the profile | `handle_new_user()` → trigger `on_auth_user_created` (baseline migration L25-40) | Auto-inserts `profiles (id = auth uid, email, full_name)`. This is why owners always get a `profiles` row even though `register-school`'s owner path never writes one. |
| 3 | Branch on email confirmation | `RegisterPage.tsx` L46-52 | If `data.user` present → `toast` + `navigate("/register-school?welcome=true")`. If not (email-confirm required) → `navigate("/owner-login")`. |
| 4 | Welcome modal → "Register School" | `src/pages/RegisterSchool.tsx` L65-67, 422-452 | `?welcome=true` opens the modal; "Skip for now" → `/main-dashboard`. |
| 5 | Page verifies a session exists | `RegisterSchool.tsx` `checkUser` (L83-94) | `supabase.auth.getUser()`; if none → toast + `/login`. Captures `userId`. |
| 6 | Auto-slug + school code | `getBaseSlug` (5-char alnum), `generateUniqueSlug` (L45-60), `handleSchoolNameChange` (L121-129) | Slug base = first 5 alnum of name; uniqueness checked by querying `schools.slug` (up to 20 tries, then `Date.now().toString(36)` suffix). School code = initials of words, ≤4/5 chars. Debounced 500 ms. |
| 7 | Optional bank details | `RegisterSchool.tsx` L363-408 | Bank from `NIGERIAN_BANKS`; account number must be exactly 10 digits (`/^\d{10}$/`). Bank details are **optional here** but required later before any Paystack payment can be taken (see §5). |
| 8 | Submit → final slug re-check, then invoke function | `handleSubmit` (L131-224) | Re-queries `schools.slug`; if taken, regenerates. Sends `owner_id: userId` in the payload. |
| 9 | Edge function validates + writes | `supabase/functions/register-school/index.ts` | Validates `schoolName`/`slug`/`schoolCode` (400 if missing). Slug taken → 409. Because `owner_id` is present, takes the **existing-user path**: `auth.admin.getUserById` (404 if not found), then inserts `schools`, then `school_admins {role:'owner'}`. |
| 10 | Seed first academic period | `register-school/index.ts` L197-224 | If no `sessions` exist for the school, inserts session `"<year>/<year+1>"` `is_current=true` + `terms` Term 1/2/3 (Term 1 `is_current=true`). |
| 11 | Redirect to admin dashboard | `RegisterSchool.tsx` L217 | `navigate(/school/${finalSlug}/admin)`. |

**Assumptions / limitations / gotchas**

- **Dead code:** `register-school` also has a *new-user* branch (creates the auth account + upserts `profiles`, rolls back with `deleteUser` on school-insert failure). The UI never reaches it — `RegisterPage` does `signUp` client-side and `RegisterSchool` always passes `owner_id`. The branch survives for API callers only.
- One auth account can own many schools (register again from `/main-dashboard` → "Create School"). Each school is an independent "branch" with its own bank details/subaccount.
- Slug uniqueness has a **TOCTOU race**: two owners registering the same name simultaneously both pass the client check; the edge function's own `slug` check (L79-93) + `schools.slug UNIQUE` are the real guard (409 / insert error).
- `school_code` drives student-ID prefixes conceptually, but the **actual** student-ID generator (`generateStudentCode`, §3) uses name initials + a random 4-digit number and ignores `school_code`. That is latent debt — the code column is essentially cosmetic today.
- A school can be created with `bank_name = NULL`; two live prod schools also have `slug = NULL` and are unreachable via `/school/:slug` (documented in `CLAUDE.md`).

---

## 2. Bursar lifecycle

Bursars are additional `school_admins` rows with `role = 'bursar'`. There are **two creation modes**, an accept flow, a forced-password-change flow, and removal/cancel. All privileged bursar operations go through owner-authenticated edge functions.

### 2a. Owner opens "Add Bursar" and the email is checked

**Who:** owner only (button rendered only when `userRole === 'owner'`, `SchoolAdminDashboard.tsx` L1200-1204).

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Owner opens the dialog; staff list loads | `SchoolAdminDashboard.tsx` `loadStaff` (L208-247), effect L855-860 | Lists current `school_admins` + non-expired pending `school_requests`, joining `profiles.email`. |
| 2 | Owner types an email | debounced effect L822-852 → `check-user-exists` | 500 ms debounce; sets `emailExists`. **Fails closed**: on error `emailExists=null` and the form refuses to submit ("Please wait for the email check to finish"). |
| 3 | `check-user-exists` scans auth users | `supabase/functions/check-user-exists/index.ts` | Service-role `auth.admin.listUsers` paginated (`perPage:1000`, up to 20 pages); case-insensitive email match → `{ exists }`. |

### 2b. Mode 1 — invite an **existing** account

**Precondition:** `emailExists === true`.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Owner submits (no password fields) | `handleAddBursar` (L883-948) | Invokes `add-bursar` with `{ email, schoolId, role:'bursar' }` (no password). |
| 2 | Function authorizes the caller | `supabase/functions/add-bursar/index.ts` L40-73 | Verifies caller JWT (`getUser`), confirms caller is the school's `owner_id` **or** an `owner` row in `school_admins`; else 403. |
| 3 | Function finds the target + guards dupes | `add-bursar` L136-162 | 400 if already a member; if a **still-valid** pending invite exists → 400; an **expired** invite is deleted so a fresh one can be sent. |
| 4 | Insert invitation | `add-bursar` L164-186 | Inserts `school_requests {status:'pending', role, requested_by: caller.id, expires_at: now+7d}`. Returns `{ created:false }`. |
| 5 | Owner sees "Invitation sent" | `handleAddBursar` L933-941 | `loadStaff()` refreshes the pending list. |

### 2c. Mode 2 — create an account with a **temp password**

**Precondition:** `emailExists === false`. The owner types/generates a password.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Owner generates a strong temp password | `generateBursarPassword` (L872-881) | 10 chars from a crypto-random alphabet (`crypto.getRandomValues`). Owner may also type one (≥6 chars, must match confirm). |
| 2 | Submit → `add-bursar` with password | `handleAddBursar` L910-920 | Sends `{ email, schoolId, role, password, fullName }`. |
| 3 | Owner-auth check | `add-bursar` L40-73 | Same 403 gate as Mode 1. |
| 4 | Create the auth user | `add-bursar` L88-104 | `auth.admin.createUser({ email_confirm:true })`. Password <6 → 400. |
| 5 | Add membership (with rollback) | `add-bursar` L106-115 | Insert `school_admins {role:'bursar'}`; on failure `deleteUser` rolls back the orphan account. |
| 6 | Flag forced rotation | `add-bursar` L117-123 | Upserts `profiles {must_change_password:true, email, full_name}`. |
| 7 | Owner sees the credentials to share | `handleAddBursar` L927-931 | `setCreatedCredentials({email,password})` renders them so the owner can hand them over (no email is sent by the app). Returns `{ created:true }`. |

### 2d. Bursar accepts an invitation (Mode 1 only)

**Who:** the invited user, from their own dashboard.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Invitee signs in → dashboard fetches invites | `src/pages/Dashboard.tsx` L121-163 | Queries `school_requests` where `user_id = me`, `status='pending'`, `expires_at >= now`; pops the invitations modal. |
| 2 | Invitee clicks Accept/Decline | `handleRequestAction` (L184-229) → `handle-school-request` | |
| 3 | Function authorizes the invitee | `supabase/functions/handle-school-request/index.ts` L36-74 | Verifies caller JWT and that `request.user_id === caller.id` (403 "not addressed to you" otherwise). Expired → marks `expired`, 400. |
| 4 | Accept → membership; update status | `handle-school-request` L89-121 | Inserts `school_admins {role: request.role}` (idempotent guard), sets request `accepted`; decline sets `declined`. |
| 5 | UI reloads | `Dashboard.tsx` L213-221 | Accept → `window.location.reload()`; the school now appears in the hub. |

### 2e. Forced password change (Mode 2 bursars)

**Who:** a bursar whose `profiles.must_change_password = true`. **Blocks everything** until cleared.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Bursar signs in at `SchoolPortal` (Admin tab) or `/login` | `SchoolPortal.tsx` `handleAdminLogin` (L114-162) / `OwnerLogin.tsx` | `signInWithPassword`; portal also verifies membership of *this* school. |
| 2 | Guard on the multi-school hub | `Dashboard.tsx` L75-85 | If `must_change_password` → `navigate("/change-password")` before loading anything. |
| 3 | Guard on the admin dashboard too | `SchoolAdminDashboard.tsx` `loadData` L421-431 | Same redirect — enforced on both entry points, so a deep link can't bypass it. |
| 4 | Bursar sets their own password | `src/pages/ChangePassword.tsx` `handleSubmit` (L44-74) | `supabase.auth.updateUser({password})` (≥6, must match), then `profiles.must_change_password=false`, then `/main-dashboard`. |

> NOTE: In "forced" mode `ChangePassword` hides the "Back to Dashboard" escape (L154-164), but the guards are the real enforcement — the page itself doesn't block navigating away by URL; the destination guards send the user right back.

### 2f. Remove a bursar

**Who:** owner only.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Owner clicks remove (confirm dialog) | `SchoolAdminDashboard.tsx` `handleRemoveBursar` (L249-265) | Invokes `remove-bursar {schoolId,userId}`. |
| 2 | Function authorizes + protects owners | `supabase/functions/remove-bursar/index.ts` | Owner-auth gate (403); refuses to remove self or any `owner` row (400 "cannot remove an owner"); 404 if target isn't a member. |
| 3 | Delete membership + kill sessions | `remove-bursar` L81-91 | Deletes the `school_admins` row, then best-effort `auth.admin.signOut(userId,'global')` so the removed user's existing JWT stops working immediately. |

### 2g. Cancel / re-send a pending invite

| Action | Who | File / function | Notes |
|---|---|---|---|
| Cancel invite | Owner | `handleCancelInvite` (L267-277) | Direct `supabase.from("school_requests").delete().eq("id",inviteId)` from the browser (RLS-gated), then `loadStaff()`. |
| Re-send after expiry | Owner | `add-bursar` L155-162 | Re-inviting an email whose only pending row is **expired** deletes it and inserts a fresh 7-day invite. A still-valid pending invite blocks a duplicate (400). |

**Bursar-lifecycle gotchas**

- **Capability gap:** a Mode-2 bursar (created with a temp password) is *not* invited via `school_requests`; they simply log in. A Mode-1 invitee who never opens their dashboard is never added — invites silently expire at 7 days and vanish from the invitee's list (`Dashboard.tsx` filters `expires_at >= now`).
- Bursar vs owner capability differences (enforced in the admin dashboard render **and** by RLS): bursars can add students, upload CSVs, and *propose* fees (always `pending`); only owners can add/remove bursars, publish/reject fees, reset student PINs, archive/restore students, and open Settings. See `03-security-rls.md` for the policy names.
- `check-user-exists` and `add-bursar` both paginate `listUsers` at 1000/page for up to 20 pages (20k accounts). Beyond that an existing email could be missed and a duplicate-create attempted (which then fails at `createUser`).

---

## 3. Student lifecycle

Students never have a Supabase auth user. Their identity is a `students` row (`student_id` + plaintext `pin`), and all reads/writes that need the PIN go through edge functions using the `verify_student_pin` RPC. **Students are never hard-deleted** — only archived (reversible).

### 3a. Admin adds a single student

**Who:** owner or bursar. **Blocked when:** a future/virtual session is selected (`Add Student` button disabled, `SchoolAdminDashboard.tsx` L1185-1192).

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Fill Surname / First / Middle / Class / **Parent email** | `handleAddStudent` (L517-555) | Surname+First+Class required; parent email required and regex-validated (needed later for Paystack receipts). |
| 2 | Generate student ID | `generateStudentCode` (L84-91) | `"<initials>-<4 random digits>"`, e.g. `OCD-1234`. Uses name initials, **not** `school_code`. |
| 3 | Insert the row (browser client, RLS-gated) | `handleAddStudent` L533-543 | Inserts `students {student_id, name, class, pin:"Password1", default_pin:"Password1", must_change_pin:true, parent_email, status:"active", school_id}`. |
| 4 | Roster refreshes | `loadData` (L413-489) | Toast reveals the default password. |

### 3b. Admin bulk-adds via CSV / Excel

**Who:** owner or bursar. **Blocked when:** future session selected.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Download template (optional) | `downloadStudentTemplate` (L621-632) | Emits `name,class` header + samples. |
| 2 | Pick a `.csv`/`.xlsx`/`.xls` file | hidden `<input>` L1167-1173 → `handleBulkStudentUpload` (L634-715) | |
| 3 | Parse | `parseCsvRows` (L95-146, quote-aware) for CSV; dynamic `import("xlsx")` for Excel | Headers normalized (`normalizeHeader`, lowercase, strip spaces/`_`/`-`). |
| 4 | Map + validate rows | L671-695 | Accepts `name`/`fullname`/`studentname`/`student` and `class`/`studentclass`/`level`; class must be in `NIGERIAN_CLASSES` (`JSS1..SSS3`). Name split by `toStudentNameParts`. Invalid rows dropped silently. |
| 5 | Bulk insert | L697-704 | `students.insert(inserts)` with `pin:"password"`, `default_pin:"password"`, `must_change_pin:true`, `status:"active"`. **No `parent_email`** on bulk rows. |

> Two different default PINs exist: single-add uses **`Password1`**, bulk-add and PIN-reset use **`password`**. Both trip `must_change_pin`. This inconsistency is latent debt worth normalizing.

### 3c. Student first login → forced PIN reset

**Who:** the student. **Trigger:** `must_change_pin = true`.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Student enters ID + default PIN at portal | `SchoolPortal.tsx` `handleStudentLogin` (L54-112) | Invokes `student-auth`. ID upper-cased/trimmed. |
| 2 | Server verifies + detects first login | `student-auth/index.ts` L62-84 → `verify_student_pin` RPC | RPC returns `must_change_pin`. |
| 3 | Redirect to forced reset | `SchoolPortal.tsx` L81-87 | If `must_change_pin` → `navigate(/school/:slug/reset-password, { state:{ studentId, currentPin } })`. **Current PIN is passed in router state** so the reset page can prove it server-side. |
| 4 | Student sets a new password | `src/pages/ResetPassword.tsx` `handleResetPassword` (L34-85) | ≥4 chars, must match confirm. Invokes `student-set-pin` with `{current_pin, new_pin}`. |
| 5 | Server re-verifies + writes | `supabase/functions/student-set-pin/index.ts` | Re-runs `verify_student_pin` (lockout-protected) on `current_pin`; on success updates `students {pin, default_pin, must_change_pin:false, is_first_login:false}`. |
| 6 | Back to portal to log in fresh | `ResetPassword.tsx` L77-78 | Navigates to `/school/:slug`; student logs in with the new PIN. |

> NOTE: The forced first-login flow accepts a "password" of **4–50 chars** (`student-set-pin` L31), not strictly a 4-digit PIN — the field is labeled "password". The *voluntary* change-PIN flow (§3e) enforces exactly 4 digits. So a first-login student can set a non-numeric password that they then cannot re-set via the 4-digit change-PIN screen without matching its stricter rule.

### 3d. Normal student login

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | ID + PIN submitted | `SchoolPortal.tsx` `handleStudentLogin` (L54-112) | `student-auth` invoked. |
| 2 | Verify + assemble session payload | `student-auth/index.ts` | `verify_student_pin` → student; then loads **published** `class_fees` for the student's class or `ALL`, the student's `payments`, all `sessions`/`terms`; computes `feeItems` (fee amount − paid, status paid/partial/unpaid). |
| 3 | Persist session client-side | `loginStudent` in `src/lib/schoolContext.tsx` | Student, fees, payments, and **credentials** stored in context + localStorage (`pity_*`). Credentials are re-sent on every later privileged call. |
| 4 | Enter dashboard | `SchoolPortal.tsx` L104-105 | `/school/:slug/student`. Dashboard re-fetches via `student-auth` per selected period (`SchoolStudentDashboard.tsx` L84-114). |

**PIN lockout** (`verify_student_pin`, migration `20260707100000_fix_verify_student_pin_lockout.sql`): a `security definer` RPC. On a **wrong** PIN it increments `students.failed_login_attempts`; at **5** consecutive failures it sets `locked_until = now()+15min`. While locked, or if the student doesn't exist / is `inactive`, it returns **zero rows** — indistinguishable from "wrong PIN" to the caller (401). A correct PIN clears the counters. The migration exists because the prod `students` table was missing `locked_until`, which 500'd every login until patched.

### 3e. Voluntary change PIN (while logged in)

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Student opens change-PIN | `src/pages/ChangePinPage.tsx` | Requires an active `useSchool()` session; else bounces to `/school/:slug`. |
| 2 | Validate new PIN | `handleChangePin` (L28-45) | Exactly 4 digits, must match confirm, must differ from current. |
| 3 | Server verifies old + writes new | `supabase/functions/change-pin/index.ts` | Re-runs `verify_student_pin(old_pin)`; on success updates `students {pin, must_change_pin:false, is_first_login:false}`. Enforces `new_pin` = exactly 4 digits. |
| 4 | Update local session | `ChangePinPage.tsx` L62-70 | `loginStudent` re-stored with the new PIN so subsequent calls use it. |

### 3f. Archive + restore (never delete)

**Who:** owner only (bursar attempts are toast-blocked client-side; RLS backs it).

| Action | File / function | Effect |
|---|---|---|
| Archive | `handleArchiveStudent` (L559-576) | `students.update({status:"archived"})`. Removed from active roster/stats but records kept. |
| Restore | `handleRestoreStudent` (L578-590) | `students.update({status:"active"})`. |
| View archived | roster toggle L1288-1298, `isArchived` L495 | `showArchived` swaps the roster; treats both `"archived"` and `"inactive"` as archived. |
| Reset PIN | `handleResetPin` (L592-608) | Owner-only; sets `pin/default_pin:"password"`, `must_change_pin:true`. |

> NOTE: `verify_student_pin` excludes only `status='inactive'` (L59), while archiving sets `status='archived'`. So an **archived** student can technically still authenticate and pay, even though the admin roster hides them. If the intent is to block archived logins, the RPC's status filter and the archive status string disagree — flag as a bug/inconsistency.

---

## 4. Fee lifecycle (pending → published, locked for the session)

`class_fees.status ∈ {pending, published}`. Fees are scoped by `school_id + class_target + session_id + term_id` and keyed for upsert by `class_fees_school_class_name_period_key` (reconcile migration L61).

| # | Step | Who | File / function | Notes |
|---|---|---|---|---|
| 1 | Open "Add Fee" | owner/bursar | `SchoolAdminDashboard.tsx` L1206-1214 | Disabled for future sessions. |
| 2 | Dialog pre-fills session/term/class + existing amounts | — | effects L282-355 | On open it **refetches** existing fees; already-**published** rows come back `locked` so they can't be edited (published = locked for the whole session). |
| 3 | Enter amounts and submit | owner/bursar | `handleAddFee` (L717-790) | Only unlocked entries with amount>0 are kept. |
| 4 | Server-side re-check before write | — | `handleAddFee` L732-751 | Re-queries statuses; drops any fee published since the dialog opened, so the `protect_published_class_fees` trigger can't abort the whole upsert batch. |
| 5 | Upsert as `pending` | — | `handleAddFee` L753-766 | `status:"pending"`, `created_by:userId`, `onConflict:"school_id,class_target,name,session_id,term_id"`. **RLS forces `pending`** on insert regardless of role. |
| 6 | Owner reviews in Fees tab | owner | Fees tab L1386-1476; `pendingFeesCount` badge L376 | Tab covers the whole selected **session** (all terms) so a pending fee for another term is never hidden. |
| 7a | **Approve & Publish** | owner only | `handleApproveFee` (L793-806) | `class_fees.update({status:"published", approved_by, approved_at})`. Only rendered when `userRole==='owner'` (L1441). Bursars see "Awaiting owner". |
| 7b | **Reject** (remove) | owner only | `handleRejectFee` (L808-819) | Deletes the pending row. |
| 8 | Students can now see/pay it | student | `student-auth` / `create-paystack-payment` filter `status='published'` | See §1 of the fee-workflow note below. |

**Immutability / enforcement** — DB trigger `protect_published_class_fees` (migration `20260707090000`, before update/delete):

- **DELETE** of a `published` row → `raise exception` (rejected **even for the service role**).
- **UPDATE** of a `published` row that changes `status` away from published, `amount`, `name`, `class_target`, `session_id`, `term_id`, or `school_id` → rejected.
- The **only** allowed transition is `pending → published` (which auto-stamps `approved_at`).

**Fee gotchas**

- The `published` filter must be added to **every** student-facing read of `class_fees` — it currently lives in `student-auth`, `create-paystack-payment`, and legacy `create-zendfi-payment`. A new reader that forgets it would leak/charge unpublished fees.
- Publishing is irreversible for the session: a wrong published amount cannot be edited or deleted — the school is stuck with it until a new session. There is no "unpublish".
- The gross-up and paid-amount math treats fee identity by **name** (payments store `"<feeName>|<amount>"`), so renaming a fee (only possible while pending) breaks matching against past payments.

---

## 5. Payment (select fees → Paystack → recorded)

Split-settlement Paystack flow. The student bears the gateway fee (checkout total grossed-up); the school's bank receives fees − 1%; the platform keeps 1% via a per-school subaccount + flat `transaction_charge`. **Precondition:** the school has `bank_name` + `account_number` set, and the `PAYSTACK_SECRET_KEY` edge secret is configured.

| # | Step | File / function | Notes |
|---|---|---|---|
| 1 | Student selects fees + amounts | `SchoolStudentDashboard.tsx` `toggleFee`/`basePaymentTotal` (L141-161) | Per-fee amount clamped to the outstanding balance (`amount − paid`). |
| 2 | Client shows grossed-up total | `grossUpKobo`/`paystackFeeKobo` (L24-37) | Duplicated from the edge function — **must stay in sync**. Fee: 1.5% + ₦100 (₦100 waived <₦2,500), capped ₦2,000. |
| 3 | Pay button → `create-paystack-payment` | pay `onClick` (L437-479) | Sends `{school_slug, student_id, pin, fee_payments, session_id, term_id, callback_url: /school/:slug/student}`. |
| 4 | Server re-verifies everything | `create-paystack-payment/index.ts` | `verify_student_pin` (401 on bad PIN); revalidates each requested fee against **published** `class_fees`; clamps each payment to `amount − alreadyPaid`; rejects if base ≤ 0 (400 "No valid payments"). |
| 5 | Lazy subaccount provisioning | `create-paystack-payment` L163-230 | If `schools.settings.paystack_subaccount_code` absent: requires bank details (400 otherwise), resolves the Paystack bank code from `bank_name` via `GET /bank` (fuzzy `normalizeBankName` match), creates a `/subaccount` (`percentage_charge:0`), caches `paystack_subaccount_code` + `paystack_bank_code` into `schools.settings` (JSONB, no schema change). |
| 6 | Compute money + init transaction | `create-paystack-payment` L158-284 | `platformFeeKobo = 1% of base`; `totalKobo = grossUp(base)`. `POST /transaction/initialize` with `amount: totalKobo`, `subaccount`, `transaction_charge: platformFeeKobo`, `bearer:"subaccount"`, unique `reference` `EDU-PS-...`, and full `metadata` (school/student ids, items, session/term). Email falls back to a synthetic `@eduledgerng.ng` if `parent_email` is missing/invalid/`.test`. |
| 7 | Redirect to hosted checkout | `SchoolStudentDashboard.tsx` L463-473 | `window.location.href = data.authorization_url`. |
| 8a | Redirect-back verify | on return, effect L52-79 → `verify-paystack-payment` | Paystack redirects to `callback_url?reference=&trxref=`. Dashboard strips the query, invokes `verify-paystack-payment`. |
| 8b | Webhook (independent, server→server) | `supabase/functions/paystack-webhook/index.ts` | Verifies `x-paystack-signature` (HMAC-SHA512, constant-time compare); logs every event to `payment_events`; on `charge.success` records the payment. |
| 9 | Idempotent recording | both `verify-paystack-payment` L55-96 and `paystack-webhook` L104-137 | Both check `payments.reference` first; insert `payments {school_id, student_id, amount: base, reference, method:"Paystack", items:["<name>|<amt>"...], session_id, term_id}`. The `payments_reference_key` unique index (reconcile migration L27) makes a webhook/verify race harmless. |
| 10 | Balance updates | `SchoolStudentDashboard.tsx` L66-68 | On success bumps `paymentRefreshKey` → re-fetch via `student-auth` recomputes fee items. |

**Payment states surfaced to the student** (`verify-paystack-payment` return / dashboard toasts):

| Paystack `data.status` | UI result |
|---|---|
| `success` | "Payment confirmed!" + balance refresh |
| `abandoned` / `failed` | "Payment was not completed." |
| pending/other | "Payment is still processing — your balance will update shortly." |
| verify 404 (`not_found`) | "Could not confirm payment status." |

**Payment gotchas / failure modes**

- **The recorded `amount` is the base (fees), not the grossed-up total charged.** The gateway fee the student paid on top is never stored — only reconstructable from Paystack.
- If the student closes the tab before the redirect, only the **webhook** records the payment (verify never runs). If the webhook secret/URL is misconfigured, only **verify** records it. Both paths existing is the safety net; losing both loses the record even though the money moved.
- Recording depends entirely on Paystack echoing back `metadata` (school_id, student_db_id, items). If metadata is stripped, both paths no-op with `note:"no_metadata"` and the payment is **not** recorded (money still settled).
- Subaccount matching is fuzzy string matching on bank names — a mismatch yields a 400 asking the owner to re-select their bank; a *wrong-but-matching* bank could route settlement incorrectly.
- Gross-up math is duplicated in two files; drift would make the displayed total differ from what Paystack charges.
- `PAYSTACK_SECRET_KEY` unset → `create-paystack-payment` 500s ("Payment provider not configured") and the webhook **rejects** all events (401) — payments cannot be taken at all (this is the current staging state per `CLAUDE.md`).

---

## Cross-cutting assumptions & debt (applies to all workflows)

- **No route guards / RLS is the floor.** The untrusted browser uses the anon key; every page self-checks and redirects, but the real enforcement is RLS + the owner-auth checks inside edge functions. See `03-security-rls.md`.
- **Students' PINs are plaintext** in `students.pin`/`default_pin`, and (per `CLAUDE.md`) the `students` table is currently anon-readable — a known security-debt item.
- **Future/virtual sessions** (`isFutureSession`) blank every list and disable Add Student / Upload / Add Fee on both dashboards; virtual ids (`future-<year>`) are not UUIDs and would `22P02` any DB filter.
- **Password recovery (owners):** `OwnerLogin` "Forgot password?" → `resetPasswordForEmail(redirectTo:/account-recovery)` → `AccountRecovery` (`updateUser`). Requires each Supabase project's Redirect URLs to include `/account-recovery`.
- **Emails are never sent by the app** for bursar invites or created credentials — the owner must hand over credentials / the invitee must happen to open their dashboard.

> NOTE (uncertainty for reviewer): I did not read `SchoolSettingsPage.tsx` in full — the claim that bank details can be edited there (referenced by payment error copy) is inferred from the error strings in `create-paystack-payment`, not verified line-by-line. Also, `ReceiptPage`/`generateReceiptPdf` and `AccountRecovery.tsx` internals were not opened; their roles are inferred from call sites.
