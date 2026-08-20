import { describe, it, expect } from "vitest";
import { pdfMoney } from "./pdfMoney";

describe("pdfMoney", () => {
  it("never emits a character jsPDF's standard fonts cannot encode", () => {
    // The bug this exists to prevent: ₦ is U+20A6, outside WinAnsi/latin-1, so
    // jsPDF rendered it as a stray ¦ on every receipt ever issued.
    for (const amount of [0, 1, 999, 50_000, 1_080_000, 12_345_678]) {
      const s = pdfMoney(amount);
      expect(() => Buffer.from(s, "latin1").toString("latin1")).not.toThrow();
      expect(s).not.toContain("₦");
      expect([...s].every((ch) => ch.charCodeAt(0) < 256)).toBe(true);
    }
  });

  it("formats with thousands separators and no decimals", () => {
    expect(pdfMoney(1_080_000)).toBe("NGN 1,080,000");
    expect(pdfMoney(5000)).toBe("NGN 5,000");
    expect(pdfMoney(0)).toBe("NGN 0");
  });

  it("rounds rather than showing kobo, and survives junk input", () => {
    expect(pdfMoney(1234.6)).toBe("NGN 1,235");
    expect(pdfMoney(NaN as number)).toBe("NGN 0");
    expect(pdfMoney(undefined as unknown as number)).toBe("NGN 0");
  });
});
