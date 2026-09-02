// The ID a student logs in with, and how a school reads it out loud.
//
// It was initials plus four random digits: "AO-2898". Two problems, and the
// first one is a bug that breaks the very first thing a school does.
//
// COLLISIONS KILLED THE WHOLE UPLOAD. `students` has `unique (school_id,
// student_id)` and the roster is inserted in ONE statement, so a single
// duplicate failed the entire batch — 300 pupils, zero created, and a raw
// Postgres error naming no row. Initials collide constantly in a Nigerian
// roster (Adebayo Ola and Adeyemi Obi are both "AO"), leaving a 1-in-9000
// chance per pair. Across a few hundred pupils it is a matter of when.
//
// AND NOBODY COULD READ THEM OUT. A parent phoning the school to ask for their
// child's ID gets "AO-2898", which is indistinguishable from AO-2988 over a bad
// line and impossible to guess if the slip is lost.
//
// So: a school prefix plus a sequential number. "GPC-0001". Collision-free by
// construction rather than by luck, obviously belonging to one school, and in a
// readable order the school can look down.
//
// The numbers are NOT secret and must not be treated as such — they are the
// username half of the credential, and the password is what protects an
// account. A sequential id makes that explicit rather than pretending four
// random digits were security.

/** Letters only, upper case, at most 4 — the school's short badge. */
export const schoolPrefix = (school: {
  school_code?: string | null;
  slug?: string | null;
  name?: string | null;
}): string => {
  const fromCode = (school.school_code || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  if (fromCode.length >= 2) return fromCode.slice(0, 4);

  const fromSlug = (school.slug || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  if (fromSlug.length >= 2) return fromSlug.slice(0, 4);

  // Initials of the school's name: "God's Pillar College" -> GPC.
  const initials = (school.name || "")
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join("");
  if (initials.length >= 2) return initials.slice(0, 4);

  return "STU";
};

/** The numeric tail of an id that belongs to this prefix, or 0. */
const tailNumber = (prefix: string, id: string): number => {
  const m = String(id || "").toUpperCase().match(/^([A-Z]+)-(\d+)$/);
  if (!m || m[1] !== prefix.toUpperCase()) return 0;
  const n = Number(m[2]);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `count` new ids for a school, guaranteed not to clash with `existingIds` or
 * with each other.
 *
 * Numbering continues from the highest existing one rather than filling gaps.
 * Reusing the id of a pupil who left would hand their login to a new child, and
 * their payment history reads by student id.
 *
 * `existingIds` is every id the school already has. The caller reads it once
 * before the batch, so the whole upload is assigned in one pass — no
 * per-row round trip, and no two rows in the same upload can collide.
 */
export const nextStudentIds = (
  prefix: string,
  existingIds: (string | null | undefined)[],
  count: number
): string[] => {
  const p = (prefix || "STU").toUpperCase();
  const taken = new Set(
    (existingIds || []).filter(Boolean).map((id) => String(id).toUpperCase())
  );

  let next = 0;
  for (const id of existingIds || []) {
    if (!id) continue;
    const n = tailNumber(p, String(id));
    if (n > next) next = n;
  }

  const out: string[] = [];
  for (let i = 0; i < Math.max(count, 0); i++) {
    // The pad is cosmetic and must not be what makes an id unique: past 9999 it
    // simply grows, and the value keeps counting rather than wrapping.
    let candidate: string;
    do {
      next += 1;
      candidate = `${p}-${String(next).padStart(4, "0")}`;
    } while (taken.has(candidate));
    taken.add(candidate);
    out.push(candidate);
  }
  return out;
};
