// Who moves when a class moves up — the one rule that stops double promotion.
//
// Moving a class at a time is how a school owner thinks: open Nursery 1, move
// Nursery 1 up. Implemented the obvious way it is also a trap. If the pupils to
// move are chosen by their CURRENT class, then moving Nursery 1 up and then
// moving Nursery 2 up sweeps the pupils you just moved along a second time and
// lands them in Nursery 3 — a year ahead, silently, and only noticed when a
// parent asks why their child skipped a year. The roster shows them in Nursery
// 2 the moment they move, so nothing on screen warns you.
//
// The rule that makes it impossible: a move reads the ENROLMENT in the session
// being left, never `students.class`.
//
//   - `students.class` is the pupil's class NOW. A move updates it, so it is
//     the cascade.
//   - The enrolment row keeps the class the pupil actually spent that session
//     in, AND its status stops being 'active' the moment they are moved. A
//     moved pupil therefore fails the filter twice over.
//
// Filter and in-memory selection are defined together here so a caller cannot
// query by one rule and reason by another; promote-session builds its query
// from movingEnrolmentFilter, and rollover.test.ts drives the same filter
// through a two-step Nursery 1 -> 2 -> 3 sequence.
//
// Mirrored for Deno at supabase/functions/_shared/rollover.ts; the two must
// stay identical below their headers (asserted by src/lib/rollover.test.ts).

export interface EnrolmentRow {
  student_id: string;
  session_id: string;
  class: string;
  status: string;
}

/** Only an enrolment nobody has resolved yet is eligible to move. */
export const MOVING_STATUS = "active";

/**
 * The columns that decide who moves, as an equality filter.
 *
 * Every key here is a column of `student_enrolments`. That is the invariant:
 * nothing derived from `students.class` may ever appear in it.
 */
export const movingEnrolmentFilter = (
  fromSessionId: string,
  onlyClass: string | null
): Record<string, string> => ({
  session_id: fromSessionId,
  status: MOVING_STATUS,
  ...(onlyClass ? { class: onlyClass } : {}),
});

/** The same filter, applied in memory. */
export const selectMoving = <T extends EnrolmentRow>(
  rows: T[],
  fromSessionId: string,
  onlyClass: string | null
): T[] => {
  const filter = movingEnrolmentFilter(fromSessionId, onlyClass);
  return rows.filter((row) =>
    Object.entries(filter).every(
      ([column, value]) => (row as unknown as Record<string, unknown>)[column] === value
    )
  );
};
