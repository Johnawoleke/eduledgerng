import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeFeeItem, parseFeeItem, parseFeeItems, sumPaidForFee } from "./feeItems";

const TUITION = "11111111-1111-4111-8111-111111111111";
const TRANSPORT_JSS1 = "22222222-2222-4222-8222-222222222222";
const TRANSPORT_ALL = "33333333-3333-4333-8333-333333333333";

describe("encodeFeeItem", () => {
  it("writes the fee id when there is one", () => {
    expect(encodeFeeItem(TUITION, "Tuition", 3000)).toBe(`${TUITION}|Tuition|3000`);
  });

  it("falls back to the legacy shape when there is no id", () => {
    expect(encodeFeeItem(null, "Tuition", 3000)).toBe("Tuition|3000");
    expect(encodeFeeItem(undefined, "Tuition", 3000)).toBe("Tuition|3000");
  });
});

describe("parseFeeItem", () => {
  it("parses the current id-carrying format", () => {
    expect(parseFeeItem(`${TUITION}|Tuition|3000`)).toEqual({
      feeId: TUITION,
      name: "Tuition",
      amount: 3000,
    });
  });

  it("parses the legacy name-only format", () => {
    expect(parseFeeItem("Tuition|3000")).toEqual({ feeId: null, name: "Tuition", amount: 3000 });
  });

  it("uses the LAST pipe for the amount, so fee names may contain '|'", () => {
    expect(parseFeeItem("Term 1 | Tuition|4000")).toEqual({
      feeId: null,
      name: "Term 1 | Tuition",
      amount: 4000,
    });
    expect(parseFeeItem(`${TUITION}|Term 1 | Tuition|4000`)).toEqual({
      feeId: TUITION,
      name: "Term 1 | Tuition",
      amount: 4000,
    });
  });

  it("does not mistake a non-uuid first segment for an id", () => {
    expect(parseFeeItem("Books|Stationery|500")).toEqual({
      feeId: null,
      name: "Books|Stationery",
      amount: 500,
    });
  });

  it("rejects malformed items", () => {
    expect(parseFeeItem("JustAName")).toBeNull();
    expect(parseFeeItem("Tuition|abc")).toBeNull();
    expect(parseFeeItem("")).toBeNull();
  });

  it("skips malformed entries when parsing a list", () => {
    expect(parseFeeItems(["JustAName", "Tuition|abc", "Tuition|1000"])).toEqual([
      { feeId: null, name: "Tuition", amount: 1000 },
    ]);
    expect(parseFeeItems(null)).toEqual([]);
  });
});

describe("sumPaidForFee — the regression this format change exists to prevent", () => {
  // Two different fees, same name, same period: one targeted at JSS1 and one at
  // ALL. Under name-only matching, paying either marked BOTH settled and the
  // school silently lost the second fee.
  const payments = [{ items: [encodeFeeItem(TRANSPORT_JSS1, "Transport", 5000)] }];

  it("credits only the fee that was actually paid", () => {
    expect(sumPaidForFee(payments, { id: TRANSPORT_JSS1, name: "Transport" })).toBe(5000);
    expect(sumPaidForFee(payments, { id: TRANSPORT_ALL, name: "Transport" })).toBe(0);
  });

  it("still reconciles legacy rows by name", () => {
    const legacy = [{ items: ["Transport|5000"] }];
    expect(sumPaidForFee(legacy, { id: TRANSPORT_JSS1, name: "Transport" })).toBe(5000);
    expect(sumPaidForFee(legacy, { id: TRANSPORT_ALL, name: "Transport" })).toBe(5000);
  });

  it("sums across rows and mixed formats", () => {
    const mixed = [
      { items: ["Tuition|3000", "Books|500"] },
      { items: [encodeFeeItem(TUITION, "Tuition", 2000)] },
    ];
    expect(sumPaidForFee(mixed, { id: TUITION, name: "Tuition" })).toBe(5000);
    expect(sumPaidForFee(mixed, { id: "other", name: "Books" })).toBe(500);
  });

  it("an id-carrying item never matches on name alone", () => {
    expect(sumPaidForFee(payments, { name: "Transport" })).toBe(0);
  });

  it("matches fee ids case-insensitively", () => {
    expect(sumPaidForFee(payments, { id: TRANSPORT_JSS1.toUpperCase(), name: "Transport" })).toBe(5000);
  });

  it("is robust to null/empty items", () => {
    expect(sumPaidForFee([], { id: TUITION, name: "Tuition" })).toBe(0);
    expect(sumPaidForFee([{ items: null }, { items: [] }, {}], { name: "Tuition" })).toBe(0);
  });
});

describe("the Deno mirror stays in sync", () => {
  // Edge functions can't import from src/, so supabase/functions/_shared/feeItems.ts
  // is a hand-kept copy. If the two drift, the amount a student is charged and
  // the amount they're credited stop agreeing — so fail the build instead.
  const stripHeader = (source: string): string =>
    source.replace(/^(\/\/.*\n|\s*\n)+/, "").trim();

  it("has identical logic to src/lib/feeItems.ts", () => {
    const root = resolve(__dirname, "../..");
    const web = readFileSync(resolve(root, "src/lib/feeItems.ts"), "utf8");
    const deno = readFileSync(resolve(root, "supabase/functions/_shared/feeItems.ts"), "utf8");

    expect(stripHeader(deno)).toBe(stripHeader(web));
  });
});
