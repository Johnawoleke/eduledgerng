import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NIGERIAN_CLASSES, classRank, nextClass, highestClassInUse, promotionFor,
} from "./classes";

describe("the class ladder", () => {
  it("is ordered lowest to highest — the order IS the promotion path", () => {
    expect(NIGERIAN_CLASSES[0]).toBe("Nursery 1");
    expect(NIGERIAN_CLASSES[NIGERIAN_CLASSES.length - 1]).toBe("SSS3");
    for (let i = 1; i < NIGERIAN_CLASSES.length; i++) {
      expect(classRank(NIGERIAN_CLASSES[i])).toBeGreaterThan(classRank(NIGERIAN_CLASSES[i - 1]));
    }
  });

  it("moves a class up by one, and stops at the top", () => {
    expect(nextClass("JSS1")).toBe("JSS2");
    expect(nextClass("Primary 6")).toBe("JSS1"); // primary feeds secondary
    expect(nextClass("SSS3")).toBeNull();
  });

  it("returns null rather than guessing at an unrecognised class", () => {
    expect(nextClass("Year 7")).toBeNull();
    expect(classRank("Year 7")).toBe(-1);
    expect(classRank(null)).toBe(-1);
  });

  it("tolerates surrounding whitespace, which rosters are full of", () => {
    expect(classRank(" JSS1 ")).toBe(classRank("JSS1"));
  });
});

describe("highestClassInUse", () => {
  it("finds the top class a school actually runs", () => {
    expect(highestClassInUse(["Primary 1", "Primary 6", "Primary 3"])).toBe("Primary 6");
    expect(highestClassInUse(["JSS1", "SSS3", "Primary 2"])).toBe("SSS3");
  });

  it("ignores unrecognised classes and empty rosters", () => {
    expect(highestClassInUse(["Year 7", "JSS2"])).toBe("JSS2");
    expect(highestClassInUse([])).toBeNull();
    expect(highestClassInUse(["Year 7"])).toBeNull();
  });
});

describe("promotionFor", () => {
  it("promotes a student in the middle of the ladder", () => {
    const r = promotionFor("JSS1", "SSS3");
    expect(r).toMatchObject({ action: "promote", nextClass: "JSS2" });
  });

  it("graduates the school's OWN highest class, not the ladder's", () => {
    // A primary-only school's leavers are in Primary 6. Graduating only at SSS3
    // would keep promoting them into classes the school does not run.
    const r = promotionFor("Primary 6", "Primary 6");
    expect(r).toMatchObject({ action: "graduate", nextClass: null });
    // ...but the same class in a through school moves up to JSS1.
    expect(promotionFor("Primary 6", "SSS3")).toMatchObject({
      action: "promote",
      nextClass: "JSS1",
    });
  });

  it("graduates at the top of the ladder even with no ceiling known", () => {
    expect(promotionFor("SSS3", null)).toMatchObject({ action: "graduate" });
  });

  it("flags an unrecognised class instead of silently leaving them behind", () => {
    const r = promotionFor("Grade 4", "SSS3");
    expect(r.action).toBe("unknown");
    expect(r.nextClass).toBeNull();
    expect(r.reason).toContain("Grade 4");
  });

  it("gives a reason a school owner would understand", () => {
    expect(promotionFor("JSS1", "SSS3").reason).toBe("JSS1 moves up to JSS2");
    expect(promotionFor("Primary 6", "Primary 6").reason).toContain("highest class");
  });
});

describe("the Deno mirror stays in sync", () => {
  const stripHeader = (s: string) => s.replace(/^(\/\/.*\n|\s*\n)+/, "").trim();
  it("has identical logic to src/lib/classes.ts", () => {
    const root = resolve(__dirname, "../..");
    const web = readFileSync(resolve(root, "src/lib/classes.ts"), "utf8");
    const deno = readFileSync(resolve(root, "supabase/functions/_shared/classes.ts"), "utf8");
    expect(stripHeader(deno)).toBe(stripHeader(web));
  });
});
