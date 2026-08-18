-- =============================================================================
-- ROLLOVER OUTCOMES AND UNDO
--
-- Two gaps the first rollover build left, both found by auditing it against how
-- real schools actually promote:
--
-- 1. A Nigerian session ends with THREE outcomes, not one. A promotion exam at
--    50%+ promotes, 40-49% is "promoted on trial" (advances, but on probation
--    and can be sent back), and below 40% repeats the class. We modelled only
--    "everyone moves up". The outcome belongs to the year being LEFT, so it is
--    recorded on that enrolment's status; the new enrolment is always 'active'.
--
-- 2. There was no undo. Standard SIS practice is to snapshot before a rollover
--    and restore if something surfaces; we cannot snapshot a shared database, so
--    instead every enrolment a rollover creates is stamped with its batch, and
--    reversing means deleting that batch.
--
-- Idempotent. Staging via `supabase db push`; production via the SQL editor.
-- =============================================================================

alter table public.student_enrolments
  add column if not exists rollover_batch uuid;

comment on column public.student_enrolments.rollover_batch is
  'Set on every enrolment created by one run of promote-session. Undoing a '
  'rollover means deleting the enrolments carrying its batch and restoring the '
  'previous session''s enrolments to active.';

create index if not exists student_enrolments_batch_idx
  on public.student_enrolments (rollover_batch)
  where rollover_batch is not null;

comment on column public.student_enrolments.status is
  'active | promoted | promoted_on_trial | repeated | graduated | withdrawn. '
  'On the session being LEFT this records the outcome of that year; a newly '
  'created enrolment is always active. promoted_on_trial is the Nigerian '
  '40-49% case: the student advances but on probation.';
