// The class ladder, and what "moving up" means on it.
//
// Extracted from SchoolAdminDashboard so promotion can share it: the rollover
// edge function needs the same ordering the Add Student dropdown uses, and two
// copies of an ordered list is how a student gets promoted into a class their
// school does not run.
//
// Mirrored for Deno at supabase/functions/_shared/classes.ts; the two must stay
// identical below their headers (asserted by src/lib/classes.test.ts).

/** Ordered lowest to highest. The order IS the promotion path. */
export const NIGERIAN_CLASSES = [
  "Nursery 1", "Nursery 2",
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
 * The highest class a school actually runs, inferred from the classes its
 * students are in.
 *
 * This is what decides who graduates. A primary-only school's leavers are in
 * Primary 6, not SSS3, so graduating only at the end of the national ladder
 * would keep promoting them into classes that do not exist there. Inferring it
 * is a guess, which is why rollover shows it for review before committing
 * rather than acting on it silently.
 */
export const highestClassInUse = (classes: (string | null | undefined)[]): string | null => {
  let best = -1;
  for (const c of classes) {
    const r = classRank(c);
    if (r > best) best = r;
  }
  return best < 0 ? null : NIGERIAN_CLASSES[best];
};

export type PromotionAction = "promote" | "graduate" | "unknown";

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
  highestInUse: string | null
): PromotionOutcome => {
  const rank = classRank(currentClass);
  if (rank < 0) {
    return {
      action: "unknown",
      nextClass: null,
      reason: `"${currentClass ?? "(none)"}" is not a class we recognise, so we cannot tell what comes next`,
    };
  }

  const ceiling = classRank(highestInUse);
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
