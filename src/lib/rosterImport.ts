// Validating an uploaded roster, and explaining what was wrong with it.
//
// The upload used to build its insert list with `.map(...).filter(Boolean)`,
// which silently discarded every row it could not read. Two bad outcomes fell
// out of that:
//
//   - Nothing valid: "No valid rows found. Use columns: name and class
//     (JSS1-SSS3)" — which names neither the offending value nor the classes
//     that would have worked. A school uploading "Basic 1" and "Nur 1" had no
//     way to learn that those are not class names the app knows.
//   - PARTIALLY valid: the good rows were inserted and the rest vanished with
//     no mention at all. Uploading 99 children and being told "50 uploaded
//     successfully" is worse than an outright failure, because nobody counts.
//
// So validation returns the rejects and why, and the caller reports both halves.
// Matching semantics are deliberately unchanged — this explains the existing
// rules rather than quietly loosening them.

import { NIGERIAN_CLASSES } from "./classes";

export type RejectReason = "missing_name" | "missing_class" | "unknown_class";

export interface RosterRow {
  [key: string]: string;
}

export interface AcceptedRow {
  line: number;
  name: string;
  className: string;
  parentEmail: string | null;
}

export interface RejectedRow {
  line: number;
  name: string;
  rawClass: string;
  reason: RejectReason;
  /** The closest real class, when the value looks like a near miss. */
  suggestion: string | null;
}

export interface RosterParseResult {
  accepted: AcceptedRow[];
  rejected: RejectedRow[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

/** Letters and digits only, for comparing class names loosely. */
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The class a value most likely meant, or null.
 *
 * Deliberately not a fuzzy string distance: "Nur 1" and "Nursery 1" share a
 * prefix and a trailing number, which is the actual shape of the mistakes
 * schools make ("Nur"/"Nursery", "Bas 2"/"Basic 2"). Matching on prefix plus
 * number is precise enough to never suggest something absurd.
 */
export const suggestClass = (raw: string): string | null => {
  const v = squash(raw);
  if (!v) return null;

  const exact = NIGERIAN_CLASSES.find((c) => squash(c) === v);
  if (exact) return exact;

  const num = v.match(/(\d+)$/)?.[1];
  const word = v.replace(/\d+$/, "");
  if (!word) return null;

  for (const c of NIGERIAN_CLASSES) {
    const cv = squash(c);
    const cNum = cv.match(/(\d+)$/)?.[1];
    const cWord = cv.replace(/\d+$/, "");
    if (num && cNum !== num) continue;
    if (cWord.startsWith(word) || word.startsWith(cWord)) return c;
  }
  return null;
};

export const parseRosterRows = (rows: RosterRow[]): RosterParseResult => {
  const accepted: AcceptedRow[] = [];
  const rejected: RejectedRow[] = [];

  rows.forEach((row, i) => {
    // +2: one for the header line, one because humans count from 1.
    const line = i + 2;
    const rawName = (row.name || row.fullname || row.studentname || row.student || "").trim();
    const rawClass = (row.class || row.studentclass || row.level || "").trim();

    if (!rawName) {
      rejected.push({ line, name: "", rawClass, reason: "missing_name", suggestion: null });
      return;
    }
    if (!rawClass) {
      rejected.push({ line, name: rawName, rawClass: "", reason: "missing_class", suggestion: null });
      return;
    }

    const className = NIGERIAN_CLASSES.find(
      (c) => c.toUpperCase() === rawClass.toUpperCase()
    );
    if (!className) {
      rejected.push({
        line, name: rawName, rawClass,
        reason: "unknown_class",
        suggestion: suggestClass(rawClass),
      });
      return;
    }

    const rawEmail =
      row.parentemail || row.parent_email || row.guardianemail ||
      row.email || row.parentsemail || row.parentguardianemail || "";
    const parentEmail = EMAIL_RE.test(rawEmail.trim()) ? rawEmail.trim().toLowerCase() : null;

    accepted.push({ line, name: rawName, className, parentEmail });
  });

  return { accepted, rejected };
};

/**
 * One sentence a school owner can act on. Leads with the unrecognised classes
 * and how many students each one costs them, because that is nearly always the
 * problem and the count is what makes it feel worth fixing.
 */
export const describeRejections = (rejected: RejectedRow[]): string => {
  if (rejected.length === 0) return "";

  const parts: string[] = [];

  const unknown = rejected.filter((r) => r.reason === "unknown_class");
  if (unknown.length > 0) {
    const byClass = new Map<string, { count: number; suggestion: string | null }>();
    for (const r of unknown) {
      const hit = byClass.get(r.rawClass);
      if (hit) hit.count += 1;
      else byClass.set(r.rawClass, { count: 1, suggestion: r.suggestion });
    }
    const listed = Array.from(byClass.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, { count, suggestion }]) =>
        `"${name}" (${count} student${count === 1 ? "" : "s"})${suggestion ? ` — did you mean ${suggestion}?` : ""}`
      );
    parts.push(`Unrecognised class${byClass.size === 1 ? "" : "es"}: ${listed.join(", ")}.`);
  }

  const noName = rejected.filter((r) => r.reason === "missing_name").length;
  if (noName > 0) parts.push(`${noName} row${noName === 1 ? "" : "s"} had no name.`);

  const noClass = rejected.filter((r) => r.reason === "missing_class").length;
  if (noClass > 0) parts.push(`${noClass} row${noClass === 1 ? "" : "s"} had no class.`);

  return parts.join(" ");
};

/** The rejected rows as CSV, so a school can fix them and re-upload just those. */
export const rejectedRowsCsv = (rejected: RejectedRow[]): string => {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const why: Record<RejectReason, string> = {
    missing_name: "No name given",
    missing_class: "No class given",
    unknown_class: "Class not recognised",
  };
  return [
    ["Row in your file", "Name", "Class you gave", "Problem", "Did you mean", "Valid classes"].map(esc).join(","),
    ...rejected.map((r) =>
      [r.line, r.name, r.rawClass, why[r.reason], r.suggestion ?? "", NIGERIAN_CLASSES.join(" / ")].map(esc).join(",")
    ),
  ].join("\n");
};

/**
 * The example roster a school downloads before filling one in.
 *
 * Two rules, both learned the hard way:
 *
 *   - It is BUILT from NIGERIAN_CLASSES, not typed out beside it. The template
 *     lived in SchoolAdminDashboard as three hand-written lines and had already
 *     drifted once (parent_email was added to the parser and never to the
 *     template, so no roster built from it could carry one). A hand-written
 *     list can also name a class the parser rejects, which teaches a school to
 *     produce a file the app then refuses.
 *   - It shows EVERY class, with more than one student in each. "Class not
 *     recognised" is the rejection schools actually hit — they write "Basic 1",
 *     "Nur 1", "JSS 1" — and the cheapest cure is a file in front of them that
 *     spells each accepted name exactly, in a row they can copy.
 *
 * Kept parseable end to end: no comment lines, no blank rows, nothing
 * parseRosterRows would report back as a reject. A school that fills the names
 * in and uploads it unchanged must succeed. rosterImport.test.ts asserts that.
 */
const TEMPLATE_STUDENTS: Record<string, [string, string][]> = {
  Creche: [["Bassey Ubong", "ubong.parent@example.com"], ["Adeniyi Simi", ""]],
  "KG 1": [["Afolabi Tomiwa", "tomiwa.parent@example.com"], ["Nnadi Chiamaka", "chiamaka.parent@example.com"]],
  "KG 2": [["Suleiman Aminu", "aminu.parent@example.com"], ["Igwe Adaeze", ""]],
  "Nursery 1": [["Adeyemi Tobi", "tobi.parent@example.com"], ["Okonkwo Chidera Amara", "chidera.parent@example.com"]],
  "Nursery 2": [["Ibrahim Zainab", "zainab.parent@example.com"], ["Eze Nnamdi", ""]],
  "Nursery 3": [["Okeke Zara", "zara.parent@example.com"], ["Lawal Idris", "idris.parent@example.com"]],
  "Primary 1": [["Bello Aisha", "aisha.parent@example.com"], ["Adeleke Seun", "seun.parent@example.com"]],
  "Primary 2": [["Musa Fatima", "fatima.parent@example.com"], ["Obi Somtochukwu", "somto.parent@example.com"]],
  "Primary 3": [["Lawal Halima", "halima.parent@example.com"], ["Nwosu Ifeanyi", "ifeanyi.parent@example.com"]],
  "Primary 4": [["Adebayo Kemi", "kemi.parent@example.com"], ["Yusuf Abdulmalik", ""]],
  "Primary 5": [["Okafor Chinedu", "chinedu.parent@example.com"], ["Balogun Tolulope", "tolu.parent@example.com"]],
  "Primary 6": [["Danjuma Grace", "grace.parent@example.com"], ["Uche Amaka", "amaka.parent@example.com"]],
  JSS1: [["Ogunleye Damilola", "damilola.parent@example.com"], ["Sani Maryam Hauwa", "maryam.parent@example.com"]],
  JSS2: [["Emeka Chukwuemeka", "emeka.parent@example.com"], ["Aliyu Hauwa", ""]],
  JSS3: [["Oladipo Bukola", "bukola.parent@example.com"], ["Etim Ekaette", "ekaette.parent@example.com"]],
  SSS1: [["Abubakar Yusuf", "yusuf.parent@example.com"], ["Nwachukwu Ngozi", "ngozi.parent@example.com"]],
  SSS2: [["Adesina Folake", "folake.parent@example.com"], ["Garba Ismail", "ismail.parent@example.com"]],
  SSS3: [["Okoro Chibuzo", "chibuzo.parent@example.com"], ["Salami Rukayat", ""]],
};

export const rosterTemplateCsv = (): string => {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = NIGERIAN_CLASSES.flatMap((className) =>
    (TEMPLATE_STUDENTS[className] ?? []).map(([name, email]) =>
      [name, className, email].map(esc).join(",")
    )
  );
  return ["name,class,parent_email", ...rows].join("\n");
};
