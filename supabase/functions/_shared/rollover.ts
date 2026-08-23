// Deno mirror of src/lib/rollover.ts — see that file for the full rationale.
//
// Edge functions cannot import from src/, so this is a hand-kept copy;
// src/lib/rollover.test.ts asserts the two stay identical below their headers.
// Regenerate this file from the source rather than editing both by hand.

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
