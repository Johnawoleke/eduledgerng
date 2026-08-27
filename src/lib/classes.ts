// The class ladder, and what "moving up" means on it.
//
// Extracted from SchoolAdminDashboard so promotion can share it: the rollover
// edge function needs the same ordering the Add Student dropdown uses, and two
// copies of an ordered list is how a student gets promoted into a class their
// school does not run.
//
// Mirrored for Deno at supabase/functions/_shared/classes.ts; the two must stay
// identical below their headers (asserted by src/lib/classes.test.ts).

/**
 * Ordered lowest to highest. The order IS the promotion path.
 *
 * The pre-primary rungs are the school's, not ours: Creche, KG 1, KG 2,
 * Nursery 1, Nursery 2, Nursery 3, then Primary 1. Confirmed by the founder
 * 2026-08-25 after a school asked for them, which matters because Nigerian
 * schools genuinely differ here — some run KG instead of Nursery rather than
 * before it.
 *
 * NOTE what adding Nursery 3 changed: Nursery 2 used to promote into Primary 1
 * and now promotes into Nursery 3. A school that does not run a Nursery 3 has
 * to override that at rollover, which the per-pupil "Into" picker allows. Every
 * rung added between two existing ones does this, which is why adding one is a
 * real decision and not a cosmetic one.
 */
export const NIGERIAN_CLASSES = [
  "Creche", "KG 1", "KG 2",
  "Nursery 1", "Nursery 2", "Nursery 3",
  "Primary 1", "Primary 2", "Primary 3", "Primary 4", "Primary 5", "Primary 6",
  "JSS1", "JSS2", "JSS3",
  "SSS1", "SSS2", "SSS3",
] as const;

export type NigerianClass = (typeof NIGERIAN_CLASSES)[number];

/** Position on the ladder, or -1 for a class we do not recognise. */
export const classRank = (c: string | null | undefined): number =>
  c == null ? -1 : (NIGERIAN_CLASSES as readonly string[]).indexOf(c.trim());

/** The next class up, or null at the top of the ladder / for an unknown class. */
export const nextClass = (c: string | null | undefined): string | null => {
  const i = classRank(c);
  if (i < 0 || i >= NIGERIAN_CLASSES.length - 1) return null;
  return NIGERIAN_CLASSES[i + 1];
};

/**
 * The highest class currently on a roster. A SUGGESTION for a school's final
 * class, never the answer.
 *
 * Inferring the graduating class from the roster is wrong in ways that matter:
 * a through school with no SSS3 students this year would graduate its SSS2s,
 * and a brand-new school whose only intake is Primary 1 would graduate its
 * entire roll on the first rollover. Both are ordinary situations. The final
 * class is a property of the SCHOOL and has to be stated by it — this only
 * seeds the default that gets confirmed.
 */
export const highestClassInUse = (classes: (string | null | undefined)[]): string | null => {
  let best = -1;
  for (const c of classes) {
    const r = classRank(c);
    if (r > best) best = r;
  }
  return best < 0 ? null : NIGERIAN_CLASSES[best];
};

// The outcomes a Nigerian session can end in. A promotion exam at 50%+
// promotes, 40-49% is "promoted on trial" (advances, on probation, can be sent
// back), below 40% repeats. Schools differ on whether they repeat at all — the
// mass-promotion argument is live — so all of these are offered and none is
// imposed.
//
// `archive` is the fifth: a pupil who is not moving up and is not staying to be
// taught either — they leave the active roster and stop being billed, record
// kept. It is NOT the same as repeating, and the difference is money: a
// repeater is still in school and still owes next session's fees, an archived
// pupil is charged nothing (the charge triggers skip status 'archived').
export type PromotionAction =
  | "promote" | "on_trial" | "repeat" | "graduate" | "archive" | "unknown";

/** What the enrolment being LEFT is stamped with for each outcome. */
export const OUTCOME_STATUS: Record<Exclude<PromotionAction, "unknown">, string> = {
  promote: "promoted",
  on_trial: "promoted_on_trial",
  repeat: "repeated",
  graduate: "graduated",
  archive: "archived",
};

/**
 * Labels in the words a school owner uses, not ours.
 *
 * Each one says what HAPPENS, not what it is called. "Repeats the class" was
 * read as jargon; "Stays in the same class" cannot be. Every outcome that takes
 * a pupil off the roster says so in the label, because that is the surprising
 * part.
 */
export const OUTCOME_LABEL: Record<PromotionAction, string> = {
  promote: "Moves up",
  on_trial: "Moves up on trial",
  repeat: "Stays in the same class",
  graduate: "Finishes school (leaves the roster)",
  archive: "Archived (leaves the roster)",
  unknown: "Class not recognised",
};

export interface PromotionOutcome {
  action: PromotionAction;
  /** The class to enrol into next session. Null when graduating or unknown. */
  nextClass: string | null;
  /** Why, in words a school owner would use. */
  reason: string;
}

/**
 * What should happen to one student at rollover.
 *
 * `unknown` is deliberate rather than a silent skip: a class the ladder does
 * not recognise (a typo, or a class a school invented) must surface in the
 * exception report so someone decides, instead of the student quietly staying
 * put for a year.
 */
export const promotionFor = (
  currentClass: string | null | undefined,
  finalClass: string | null
): PromotionOutcome => {
  const rank = classRank(currentClass);
  if (rank < 0) {
    return {
      action: "unknown",
      nextClass: null,
      reason: `"${currentClass ?? "(none)"}" is not a class we recognise, so we cannot tell what comes next`,
    };
  }

  const ceiling = classRank(finalClass);
  if (ceiling >= 0 && rank >= ceiling) {
    return {
      action: "graduate",
      nextClass: null,
      reason: `${currentClass} is the highest class this school runs`,
    };
  }

  const up = nextClass(currentClass);
  if (!up) {
    return {
      action: "graduate",
      nextClass: null,
      reason: `${currentClass} is the top of the ladder`,
    };
  }
  return { action: "promote", nextClass: up, reason: `${currentClass} moves up to ${up}` };
};
