import { describe, it, expect } from "vitest";
import { parseRosterRows, describeRejections, rejectedRowsCsv, suggestClass } from "./rosterImport";

const row = (name: string, cls: string, email = "") =>
  ({ name, class: cls, parentemail: email });

describe("parseRosterRows", () => {
  it("accepts a clean row and normalises the class to its canonical name", () => {
    const { accepted, rejected } = parseRosterRows([row("Bello Aisha", "primary 3", "a@b.com")]);
    expect(rejected).toHaveLength(0);
    expect(accepted[0]).toMatchObject({
      line: 2, name: "Bello Aisha", className: "Primary 3", parentEmail: "a@b.com",
    });
  });

  it("keeps the good rows AND reports the bad ones in the same upload", () => {
    // The old code inserted the good ones and silently dropped the rest, so a
    // school uploading 99 children was told "50 uploaded successfully".
    const { accepted, rejected } = parseRosterRows([
      row("A One", "JSS1"),
      row("B Two", "Basic 1"),
      row("C Three", "Primary 2"),
    ]);
    expect(accepted.map((a) => a.name)).toEqual(["A One", "C Three"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ line: 3, rawClass: "Basic 1", reason: "unknown_class" });
  });

  it("reports the line number as it appears in the school's file", () => {
    const { rejected } = parseRosterRows([row("A", "JSS1"), row("B", "Nope")]);
    expect(rejected[0].line).toBe(3); // header is line 1
  });

  it("distinguishes a missing name from a missing class", () => {
    const { rejected } = parseRosterRows([row("", "JSS1"), row("Has Name", "")]);
    expect(rejected.map((r) => r.reason)).toEqual(["missing_name", "missing_class"]);
  });

  it("only keeps a parent email that is actually an email", () => {
    const { accepted } = parseRosterRows([
      row("A", "JSS1", "not-an-email"),
      row("B", "JSS1", "  Real@Example.COM  "),
    ]);
    expect(accepted[0].parentEmail).toBeNull();
    expect(accepted[1].parentEmail).toBe("real@example.com");
  });
});

describe("suggestClass", () => {
  it("maps the abbreviations schools actually use", () => {
    expect(suggestClass("Nur 1")).toBe("Nursery 1");
    expect(suggestClass("nursery1")).toBe("Nursery 1");
    expect(suggestClass("Pri 4")).toBe("Primary 4");
  });

  it("does not suggest a different year", () => {
    expect(suggestClass("Nur 3")).toBeNull();   // there is no Nursery 3
    expect(suggestClass("Basic 9")).toBeNull();
  });

  it("says nothing rather than guessing wildly", () => {
    expect(suggestClass("Basic 1")).toBeNull(); // "Basic" is not "Primary"
    expect(suggestClass("")).toBeNull();
    expect(suggestClass("???")).toBeNull();
  });
});

describe("describeRejections — the message a school owner reads", () => {
  it("names each bad class and how many students it costs", () => {
    const { rejected } = parseRosterRows([
      row("A", "Basic 1"), row("B", "Basic 1"), row("C", "Pre-Nur 2"),
    ]);
    const msg = describeRejections(rejected);
    expect(msg).toContain('"Basic 1" (2 students)');
    expect(msg).toContain('"Pre-Nur 2" (1 student)');
  });

  it("offers the near miss when there is one", () => {
    const { rejected } = parseRosterRows([row("A", "Nur 1")]);
    expect(describeRejections(rejected)).toContain("did you mean Nursery 1?");
  });

  it("lists the worst offender first", () => {
    const { rejected } = parseRosterRows([
      row("A", "Rare"), row("B", "Common"), row("C", "Common"), row("D", "Common"),
    ]);
    const msg = describeRejections(rejected);
    expect(msg.indexOf("Common")).toBeLessThan(msg.indexOf("Rare"));
  });

  it("mentions missing names and classes too", () => {
    const { rejected } = parseRosterRows([row("", "JSS1"), row("X", "")]);
    const msg = describeRejections(rejected);
    expect(msg).toContain("1 row had no name");
    expect(msg).toContain("1 row had no class");
  });

  it("is empty when nothing was rejected", () => {
    expect(describeRejections([])).toBe("");
  });
});

describe("rejectedRowsCsv", () => {
  it("gives back the failed rows with the reason and the valid classes", () => {
    const { rejected } = parseRosterRows([row("Kelechi Majesty", "Pre-Nur 2")]);
    const csv = rejectedRowsCsv(rejected);
    expect(csv).toContain("Kelechi Majesty");
    expect(csv).toContain("Pre-Nur 2");
    expect(csv).toContain("Class not recognised");
    expect(csv).toContain("Nursery 1");
  });

  it("escapes a name containing a comma", () => {
    const { rejected } = parseRosterRows([row('Smith, John', "Nope")]);
    expect(rejectedRowsCsv(rejected)).toContain('"Smith, John"');
  });
});

describe("the Lively Kids upload, end to end", () => {
  it("rejects all 99 and explains exactly why", () => {
    const roster = [
      ...Array(9).fill(0).map((_, i) => row(`PreNur2 ${i}`, "Pre-Nur 2")),
      ...Array(1).fill(0).map((_, i) => row(`PreNur1 ${i}`, "Pre-Nur 1")),
      ...Array(18).fill(0).map((_, i) => row(`Nur1 ${i}`, "Nur 1")),
      ...Array(8).fill(0).map((_, i) => row(`Nur2 ${i}`, "Nur 2")),
      ...Array(6).fill(0).map((_, i) => row(`Nur3 ${i}`, "Nur 3")),
      ...Array(57).fill(0).map((_, i) => row(`Basic ${i}`, `Basic ${(i % 5) + 1}`)),
    ];
    const { accepted, rejected } = parseRosterRows(roster);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(99);

    const msg = describeRejections(rejected);
    expect(msg).toContain('"Nur 1" (18 students) — did you mean Nursery 1?');
    expect(msg).toContain('"Pre-Nur 2" (9 students)');
    // "Basic" is a genuinely different vocabulary, so no misleading suggestion.
    expect(msg).not.toContain('"Basic 1" (12 students) — did you mean');
  });
});
