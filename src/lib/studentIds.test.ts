import { describe, it, expect } from "vitest";
import { schoolPrefix, nextStudentIds } from "./studentIds";

describe("schoolPrefix", () => {
  it("prefers the school's own code", () => {
    expect(schoolPrefix({ school_code: "GPC", slug: "godsp", name: "God's Pillar College" }))
      .toBe("GPC");
  });

  it("falls back to the slug, then to the name's initials", () => {
    expect(schoolPrefix({ slug: "godsp", name: "God's Pillar College" })).toBe("GODS");
    expect(schoolPrefix({ name: "God's Pillar College" })).toBe("GPC");
  });

  it("strips punctuation and digits, and never exceeds four letters", () => {
    expect(schoolPrefix({ school_code: "g-p-c-2026" })).toBe("GPC");
    expect(schoolPrefix({ name: "Bright Academy International School Ikeja" })).toBe("BAIS");
  });

  it("always returns something usable", () => {
    expect(schoolPrefix({})).toBe("STU");
    expect(schoolPrefix({ name: "!!!", slug: "1" })).toBe("STU");
  });
});

describe("nextStudentIds", () => {
  it("numbers from one for a school's first intake", () => {
    expect(nextStudentIds("GPC", [], 3)).toEqual(["GPC-0001", "GPC-0002", "GPC-0003"]);
  });

  it("continues from the highest existing number", () => {
    expect(nextStudentIds("GPC", ["GPC-0001", "GPC-0007", "GPC-0003"], 2))
      .toEqual(["GPC-0008", "GPC-0009"]);
  });

  it("NEVER reuses the id of a pupil who left", () => {
    // Reusing a number hands a departed pupil's login, and their payment
    // history, to a new child.
    const ids = nextStudentIds("GPC", ["GPC-0001", "GPC-0002", "GPC-0003"], 1);
    expect(ids).toEqual(["GPC-0004"]);
  });

  it("returns no duplicates within one upload", () => {
    // The bug this replaces: the roster is inserted in ONE statement, so a
    // single duplicate failed all 300 rows with no indication which.
    const ids = nextStudentIds("GPC", [], 300);
    expect(new Set(ids).size).toBe(300);
  });

  it("never collides with an id the school already has", () => {
    const existing = nextStudentIds("GPC", [], 50);
    const more = nextStudentIds("GPC", existing, 50);
    expect(new Set([...existing, ...more]).size).toBe(100);
  });

  it("ignores ids belonging to a different prefix", () => {
    // A school that changed its code still numbers forward on the new one.
    expect(nextStudentIds("GPC", ["OLD-0042", "OCD-1234"], 1)).toEqual(["GPC-0001"]);
  });

  it("survives a legacy roster of random-suffix ids", () => {
    // Existing schools carry "AO-2898" style ids. They do not match the prefix,
    // so numbering starts fresh, and the set guard stops any accidental clash.
    const legacy = ["AO-2898", "BC-1234", "GPC-0002"];
    expect(nextStudentIds("GPC", legacy, 2)).toEqual(["GPC-0003", "GPC-0004"]);
  });

  it("keeps counting past four digits rather than wrapping", () => {
    expect(nextStudentIds("GPC", ["GPC-9999"], 2)).toEqual(["GPC-10000", "GPC-10001"]);
  });

  it("copes with nulls and a zero count", () => {
    expect(nextStudentIds("GPC", [null, undefined, ""], 1)).toEqual(["GPC-0001"]);
    expect(nextStudentIds("GPC", [], 0)).toEqual([]);
  });
});
