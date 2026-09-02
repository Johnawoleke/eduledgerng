# Resetting production before onboarding real schools

Empties every application table so schools start on a clean system. Keeps the
schema, RLS policies, functions, triggers and migration history — only rows go.

**This is irreversible.** Everything below assumes you have a backup you have
actually confirmed exists.

## Before you run anything

1. **Take a backup and verify it.** Supabase → Database → Backups. Confirm one
   is dated today. Do not rely on "there's probably a daily".
2. **Tell John.** Any account he has stops working the moment step 3 runs.
3. **Pick a quiet moment.** A parent mid-payment when this runs gets a charge
   with no fee row behind it — the money would sit at Paystack, unattributable.

## Step 1 — see what you are about to delete

```sql
select 'schools' t, count(*) from public.schools
union all select 'students', count(*) from public.students
union all select 'payments', count(*) from public.payments
union all select 'class_fees', count(*) from public.class_fees
union all select 'student_charges', count(*) from public.student_charges
union all select 'profiles (login accounts)', count(*) from public.profiles;
```

If `payments` shows rows with real money against them, **stop** and export them
first. Once truncated there is no record of who paid what.

## Step 2 — wipe the application data

Run `scripts/reset-database.sql` in the SQL editor. One transaction: it either
all succeeds or nothing changes.

It uses TRUNCATE rather than DELETE for two reasons, both load-bearing:

- `class_fees` carries `protect_published_class_fees`, a BEFORE DELETE trigger
  that raises *"Published fees are locked for the session and cannot be
  deleted"* — even for the service role. A DELETE-based wipe stops dead there.
  TRUNCATE does not fire row triggers.
- `payments` and `student_charges` reference sessions/terms/class_fees with
  `ON DELETE RESTRICT`. Ordered DELETEs must get the order exactly right or they
  fail halfway and leave the database half-cleared.

Verified against staging with real data (2 schools, 17 students, 8 payments, 118
charges) via `scripts/verify-reset.mjs`, which runs it inside a transaction and
rolls back.

## Step 3 — login accounts (a separate decision)

Step 2 does NOT touch logins. Owners and bursars can still sign in; they will
just see no schools. `profiles` cascades from `auth.users`, so deleting the user
removes the profile.

**Keep your own and John's, delete the rest** — usually what you want:

```sql
delete from auth.users
 where email not in ('john@example.com', 'satyam@example.com');
```

**Or clear everything and re-register from scratch:**

```sql
delete from auth.users;
```

Either way both of you should re-register your schools afterwards, so the data
is created the way a real school creates it.

## What this does NOT clean

- **Paystack subaccounts.** They live at Paystack, not here. The two for God's
  Pillar College remain; delete them in the Paystack dashboard if you want a
  clean slate. A re-registered school provisions a NEW subaccount, which needs
  verifying again.
- **Supabase edge function secrets** — unaffected, and should be.
- **Storage** — nothing is uploaded today, so there is nothing to clear.

## After the reset

1. Register one school the way a real school will, end to end.
2. Add its bank details, then take one small real payment.
3. **Verify the new subaccount in Paystack** the moment it appears, or that
   school collects fees and receives nothing.
4. Run `npm run paystack:unverified` to confirm nothing is left blocked.

Staging is unaffected by all of this and stays as the test environment —
`npm run test:staging` and `npm run test:payments` keep working.
