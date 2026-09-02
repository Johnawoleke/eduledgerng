import { describe, it, expect } from "vitest";
import { generateCredentialSlips, slipPageCount } from "./generateCredentialSlips";

const slip = (n: number) => ({
  studentId: `GPC-${String(n).padStart(4, "0")}`,
  name: `Pupil Number ${n}`,
  className: "Primary 3",
  tempPassword: `Temp${n}pass`,
});

const opts = { schoolName: "God's Pillar College", portalUrl: "https://www.eduledgerng.com/school/godsp" };

describe("credential slips", () => {
  it("fits six pupils to a sheet", () => {
    expect(slipPageCount(1)).toBe(1);
    expect(slipPageCount(6)).toBe(1);
    expect(slipPageCount(7)).toBe(2);
    expect(slipPageCount(300)).toBe(50);
  });

  it("always claims at least one page, even for nobody", () => {
    expect(slipPageCount(0)).toBe(1);
    expect(slipPageCount(-5)).toBe(1);
  });

  it("produces a real multi-page PDF for a whole school", () => {
    const doc = generateCredentialSlips(
      Array.from({ length: 300 }, (_, i) => slip(i + 1)), opts
    );
    expect(doc.getNumberOfPages()).toBe(50);
    expect(doc.output("blob").size).toBeGreaterThan(0);
  });

  it("does not throw on a name or URL far longer than a slip", () => {
    // A school's real name plus a long custom domain overruns the box; it must
    // wrap or clip, never crash the download the school is waiting on.
    const doc = generateCredentialSlips(
      [{ ...slip(1), name: "Oluwaseunfunmi Adebayo-Ogundimu Chukwuemeka".repeat(3) }],
      { schoolName: "A Very Long School Name ".repeat(6),
        portalUrl: "https://a-very-long-custom-domain.example.com/school/a-long-slug" }
    );
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it("handles an empty list without producing a broken file", () => {
    const doc = generateCredentialSlips([], opts);
    expect(doc.getNumberOfPages()).toBe(1);
  });
});
