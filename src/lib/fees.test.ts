import { describe, it, expect } from "vitest";
import { sumPaidForFee, feeStatus, countStudentsInClass, outstandingForFee } from "./fees";
import { parsePaymentItems } from "./generateReceiptPdf";

describe("sumPaidForFee — how much has been paid toward a fee", () => {
  it("sums across multiple payment rows and multiple items", () => {
    const payments = [
      { items: ["Tuition|3000", "Books|500"] },
      { items: ["Tuition|2000"] },
      { items: ["Uniform|1500"] },
    ];
    expect(sumPaidForFee(payments, "Tuition")).toBe(5000);
    expect(sumPaidForFee(payments, "Books")).toBe(500);
    expect(sumPaidForFee(payments, "Uniform")).toBe(1500);
    expect(sumPaidForFee(payments, "Nonexistent")).toBe(0);
  });

  it("uses the LAST pipe, so fee names containing '|' still parse", () => {
    const payments = [{ items: ["Term 1 | Tuition|4000"] }];
    expect(sumPaidForFee(payments, "Term 1 | Tuition")).toBe(4000);
  });

  it("ignores malformed items (no pipe, non-numeric amount)", () => {
    const payments = [{ items: ["JustAName", "Tuition|abc", "Tuition|1000"] }];
    expect(sumPaidForFee(payments, "Tuition")).toBe(1000);
    expect(sumPaidForFee(payments, "JustAName")).toBe(0);
  });

  it("is robust to null/empty items and empty payment list", () => {
    expect(sumPaidForFee([], "Tuition")).toBe(0);
    expect(sumPaidForFee([{ items: null }, { items: [] }, {}], "Tuition")).toBe(0);
  });

  it("does not match a different fee whose name is a prefix", () => {
    const payments = [{ items: ["Tuition Fee|1000", "Tuition|2000"] }];
    expect(sumPaidForFee(payments, "Tuition")).toBe(2000);
    expect(sumPaidForFee(payments, "Tuition Fee")).toBe(1000);
  });
});

describe("feeStatus", () => {
  it("paid when paid >= amount", () => {
    expect(feeStatus(5000, 5000)).toBe("paid");
    expect(feeStatus(6000, 5000)).toBe("paid");
  });
  it("partial when 0 < paid < amount", () => {
    expect(feeStatus(1, 5000)).toBe("partial");
    expect(feeStatus(4999, 5000)).toBe("partial");
  });
  it("unpaid when nothing paid", () => {
    expect(feeStatus(0, 5000)).toBe("unpaid");
  });
});

describe("outstandingForFee — never negative, over-payment clamped", () => {
  it("returns the remainder", () => {
    expect(outstandingForFee(5000, 2000)).toBe(3000);
  });
  it("is zero when fully paid or over-paid", () => {
    expect(outstandingForFee(5000, 5000)).toBe(0);
    expect(outstandingForFee(5000, 9999)).toBe(0);
  });
});

describe("countStudentsInClass — 'applies to N students'", () => {
  const students = [
    { class: "JSS1" },
    { class: "JSS1" },
    { class: "Primary 3" },
    { class: "SSS2" },
  ];
  it("counts a specific class", () => {
    expect(countStudentsInClass(students, "JSS1")).toBe(2);
    expect(countStudentsInClass(students, "Primary 3")).toBe(1);
    expect(countStudentsInClass(students, "Nursery 1")).toBe(0);
  });
  it("ALL counts everyone", () => {
    expect(countStudentsInClass(students, "ALL")).toBe(4);
  });
  it("empty roster -> 0", () => {
    expect(countStudentsInClass([], "JSS1")).toBe(0);
  });
});

describe("parsePaymentItems (receipt display) — existing helper", () => {
  it("parses name|amount pairs", () => {
    expect(parsePaymentItems(["Tuition|3000", "Books|500"])).toEqual([
      { name: "Tuition", amount: 3000 },
      { name: "Books", amount: 500 },
    ]);
  });
  it("keeps a bare name with amount 0 when there's no valid pipe", () => {
    expect(parsePaymentItems(["Cash Payment"])).toEqual([{ name: "Cash Payment", amount: 0 }]);
  });
  it("handles null/empty", () => {
    expect(parsePaymentItems(null)).toEqual([]);
    expect(parsePaymentItems([])).toEqual([]);
  });
});
