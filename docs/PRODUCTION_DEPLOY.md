# Production deploy — 2026-08-03 security release

Production is `ifonivphhfplntzshtsb` ("Johnawoleke's Project"). The CLI is
deliberately linked to **staging**, so every command below targets production
explicitly. Everything here has already been applied and verified on staging.

**Read the whole file before starting.** Step 2 and step 3 must land back to
back — see the warning under step 2.

---

## 0. Before you start

- Do this at a low-traffic time. There is a short window in step 2/3 where
  checkout returns an error.
- Have the production database password to hand (`db push` will prompt).
- Confirm nothing else is mid-deploy on Vercel.

Sanity-check what you are about to change:

```sh
supabase db query --db-url "$PROD_DB_URL" \
  "select count(*) as students, count(*) filter (where must_change_pin) as unrotated from public.students"
```

The number of students matters: the bcrypt backfill in `20260803110000` is
roughly **one minute per thousand students**, in a single transaction. Under
~5,000 the SQL editor is fine. Above that, run it from `psql` so it cannot hit a
statement timeout mid-way.

---

## 1. Migrations (safe — do this first, on its own)

Six migrations are pending:

| File | What it does |
|---|---|
| `20260729120000_payment_notifications.sql` | in-app payment notification feed |
| `20260803100000_lock_down_financial_reads.sql` | `payments`/`fee_items` become member-only; `payment_events` becomes service-role-only and leaves Realtime; existing stored card/IP data is redacted |
| `20260803110000_hash_student_pins.sql` | bcrypt trigger + backfill; `verify_student_pin` switches to `crypt()` |
| `20260803120000_student_sessions_and_throttle.sql` | session tokens, per-IP login throttle, settlement-account guard |
| `20260803130000_default_pin_invariant.sql` | clears plaintext passwords out of `default_pin` and enforces the invariant |
| `20260803140000_protect_academic_periods.sql` | FKs so a period with money cannot be deleted; owner-only period writes |

### Before running `20260803140000`, record what it will repair

Production **does** contain orphaned rows — fees and payments pointing at a
session that no longer exists. That is evidence a session really was deleted at
some point, which is exactly the hole this migration closes. The migration nulls
those dangling references so the foreign keys can be created. Capture them first,
because afterwards the link is gone for good:

```sql
select 'class_fees' as tbl, id, name, amount, class_target, status, session_id, term_id
from public.class_fees c
where (c.session_id is not null and not exists (select 1 from public.sessions s where s.id = c.session_id))
   or (c.term_id    is not null and not exists (select 1 from public.terms    t where t.id = c.term_id))
union all
select 'payments', id, reference, amount, method, status, session_id, term_id
from public.payments p
where (p.session_id is not null and not exists (select 1 from public.sessions s where s.id = p.session_id))
   or (p.term_id    is not null and not exists (select 1 from public.terms    t where t.id = p.term_id));
```

Export that result before proceeding. If any **payments** appear, those are real
transactions whose period attribution is about to be lost — keep the export as
the record of what they were for.

> Note: the migration deliberately disables `protect_published_class_fees` for
> the two `class_fees` cleanup statements and re-enables it immediately. That
> trigger rejects any change to a published fee's `session_id`, which is correct
> in normal operation but would otherwise block this one-time repair with
> `ERROR: P0001: Published fees are locked for the session and cannot be changed`.
> After the migration, confirm the trigger is back on — `tgenabled` must be `O`:
>
> ```sql
> select tgenabled from pg_trigger
> where tgname = 'protect_published_class_fees'
>   and tgrelid = 'public.class_fees'::regclass;
> ```

These are **backward compatible with the functions currently deployed on
production** — the old functions call `verify_student_pin`, whose signature is
unchanged. You can apply them and stop here safely if you need to.

Either paste each file into **Dashboard → SQL Editor in filename order**, or:

```sh
supabase link --project-ref ifonivphhfplntzshtsb
supabase db push
supabase link --project-ref vmqeqwszeekzkvtxkebv   # relink to staging afterwards
```

Verify:

```sql
select
  (select count(*) from public.students where pin !~ '^\$2[abxy]?\$') as unhashed_pins,
  (select count(*) from public.students where not must_change_pin and default_pin is not null) as plaintext_leaks,
  (select count(*) from pg_policies where schemaname='public' and tablename='payment_events') as payment_event_policies,
  (select count(*) from public.class_fees c where c.session_id is not null
     and not exists (select 1 from public.sessions s where s.id = c.session_id)) as orphan_fees,
  (select tgenabled from pg_trigger where tgname='protect_published_class_fees'
     and tgrelid='public.class_fees'::regclass) as fee_lock_trigger;
```

Expect `0, 0, 0, 0, O`.

---

## 2. Edge functions

> **⚠️ From the moment this finishes until step 3 is live, "Pay Fees Online"
> returns an error.** The deployed frontend still sends the student's password to
> `create-paystack-payment`, which now requires a session token. Nothing is
> charged and nothing is lost — a parent who tries gets a failure and can retry
> once step 3 is up. Keep the gap to a couple of minutes.

```sh
supabase functions deploy student-auth change-pin student-set-pin \
  create-paystack-payment verify-paystack-payment paystack-webhook \
  register-school --project-ref ifonivphhfplntzshtsb
```

Then remove the four deleted functions. Deleting the source files does **not**
remove them from Supabase, and `student-payment` can write `payments` rows that
default to `status = 'success'` with no gateway involved:

```sh
for f in student-payment create-zendfi-payment zendfi-webhook check-user-exists; do
  supabase functions delete "$f" --project-ref ifonivphhfplntzshtsb
done
```

---

## 3. Frontend (immediately after step 2)

```sh
git push origin main     # Vercel builds and deploys, ~2 min
```

Confirm the deploy is live in the Vercel dashboard, then smoke-test:

- a student logs in
- their balance renders
- "Pay Fees Online" reaches the Paystack checkout page

---

## 4. Post-deploy settings

- **Supabase Auth → URL Configuration** — add your production origin's
  `/account-recovery` to Redirect URLs, and update Site URL. Do this for the new
  custom domain too, or owner password recovery silently fails on it.
- **Supabase Auth → enable "Secure password change"** (requires reauthentication
  for `updateUser({password})`).
- **Paystack dashboard** — confirm the webhook URL still points at
  `https://ifonivphhfplntzshtsb.supabase.co/functions/v1/paystack-webhook`.

---

## 5. The two decisions that are yours

**Rotate every student password.** `student-set-pin` used to write each
student's *chosen* password into `students.default_pin` in plaintext, and
`students` was anon-readable until migration `20260707120000`. On staging this
affected 16 of 17 students. Migration `20260803130000` clears the column, but it
cannot un-leak what was already exposed. Assume every production student
password is compromised:

```sh
supabase db query --db-url "$PROD_DB_URL" \
  "update public.students set must_change_pin = true where coalesce(status,'active') = 'active'"
```

This forces every student through the first-login password reset. Note it does
**not** issue new temporary passwords — students still need their current one to
authenticate before choosing a new one. To also issue fresh temporary passwords,
use the owner's "Reset password" button per student, which generates a random one
and displays it.

**Rotate the anon key, and decide about disclosure.** The anon key was never
secret, but until `20260803100000` it could read every payment row and every raw
webhook payload — card BIN/last4/expiry, payer email, IP — across all schools.
Treat that data as leaked and decide whether affected schools need telling.

---

## Rollback

The migrations only tighten access and add constraints; none drop data. If
something breaks, the fast path is to redeploy the previous frontend build from
Vercel's deployment history and re-deploy the previous function versions — not to
reverse the migrations, which would re-open the holes. The one genuinely
irreversible step is the bcrypt backfill: the original plaintext passwords are
gone, by design.
