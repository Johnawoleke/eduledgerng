import { describe, it, expect } from "vitest";
import {
  PLATFORM_FEE_RATE,
  paystackFeeKobo,
  grossUpKobo,
  computeCheckoutKobo,
} from "./paystackFees";

const KOBO = (ngn: number) => Math.round(ngn * 100);

// Ascending sweep: fine-grained ₦0.01..₦3,000 (every kobo), then coarse to
// ₦300,000 (past where Paystack's ₦2,000 fee cap kicks in, ~₦126,666).
const sweep: number[] = [];
for (let k = 1; k <= 300_000; k += 1) sweep.push(k);
for (let k = 300_500; k <= 30_000_000; k += 500) sweep.push(k);

// Find the first sweep value that violates `ok`, or null if none do. Keeps the
// assertion count at 1 per test (calling expect() a million times is very slow).
const firstViolation = (ok: (k: number) => boolean): number | null => {
  for (const k of sweep) if (!ok(k)) return k;
  return null;
};

describe("paystackFeeKobo — Paystack NGN pricing", () => {
  it("is 1.5% (ceil) below the ₦2,500 flat-fee threshold, no ₦100 added", () => {
    expect(paystackFeeKobo(KOBO(1000))).toBe(Math.ceil(0.015 * KOBO(1000)));
    expect(paystackFeeKobo(KOBO(2499))).toBe(Math.ceil(0.015 * KOBO(2499)));
  });

  it("adds the ₦100 flat fee at/above ₦2,500", () => {
    expect(paystackFeeKobo(249_900)).toBe(Math.ceil(0.015 * 249_900));
    expect(paystackFeeKobo(250_000)).toBe(Math.ceil(0.015 * 250_000 + 10_000));
  });

  it("jumps by ~₦100 across the ₦2,500 boundary", () => {
    const jump = paystackFeeKobo(250_000) - paystackFeeKobo(249_999);
    expect(jump).toBeGreaterThanOrEqual(9_990);
    expect(jump).toBeLessThanOrEqual(10_010);
  });

  it("is capped at ₦2,000 (200,000 kobo) for large amounts", () => {
    expect(paystackFeeKobo(KOBO(200_000))).toBe(200_000);
    expect(paystackFeeKobo(KOBO(10_000_000))).toBe(200_000);
  });

  it("stays within [0, ₦2,000] across the whole sweep", () => {
    expect(firstViolation((k) => {
      const fee = paystackFeeKobo(k);
      return fee >= 0 && fee <= 200_000;
    })).toBeNull();
  });

  it("is monotonically non-decreasing", () => {
    let prev = -1;
    expect(firstViolation((k) => {
      const fee = paystackFeeKobo(k);
      const ok = fee >= prev;
      prev = fee;
      return ok;
    })).toBeNull();
  });
});

describe("grossUpKobo — the school is NEVER under-settled (critical invariant)", () => {
  it("returns 0 for non-positive input", () => {
    expect(grossUpKobo(0)).toBe(0);
    expect(grossUpKobo(-100)).toBe(0);
  });

  it("guarantees total - paystackFee(total) >= base for the whole sweep", () => {
    // THE money invariant: the school always receives at least what it was owed.
    expect(firstViolation((base) => {
      const total = grossUpKobo(base);
      return total - paystackFeeKobo(total) >= base;
    })).toBeNull();
  });

  it("never over-charges by more than ₦2 (settled overshoot is tiny)", () => {
    expect(firstViolation((base) => {
      const total = grossUpKobo(base);
      const settled = total - paystackFeeKobo(total);
      return settled - base <= 200 && total >= base;
    })).toBeNull();
  });

  it("is monotonically non-decreasing in base", () => {
    let prev = -1;
    expect(firstViolation((base) => {
      const total = grossUpKobo(base);
      const ok = total >= prev;
      prev = total;
      return ok;
    })).toBeNull();
  });
});

describe("computeCheckoutKobo — full checkout breakdown", () => {
  it("uses a 1% platform rate", () => {
    expect(PLATFORM_FEE_RATE).toBe(0.01);
  });

  it("matches a hand-computed ₦5,000 example exactly", () => {
    const b = computeCheckoutKobo(5000);
    expect(b.baseKobo).toBe(500_000);
    expect(b.platformFeeKobo).toBe(5_000);
    expect(b.targetSettledKobo).toBe(505_000);
    expect(b.totalKobo).toBe(522_843);
    expect(b.processingFeeKobo).toBe(17_843);
    expect(b.totalKobo - paystackFeeKobo(b.totalKobo)).toBe(505_000);
  });

  it("platform fee is round(1% of base) and the school gets the EXACT fee + platform", () => {
    for (const ngn of [1, 50, 100, 999, 1000, 2500, 5000, 12345, 50_000, 250_000, 1_000_000]) {
      const b = computeCheckoutKobo(ngn);
      expect(b.platformFeeKobo).toBe(Math.round(b.baseKobo * 0.01));
      expect(b.targetSettledKobo).toBe(b.baseKobo + b.platformFeeKobo);
      const settled = b.totalKobo - paystackFeeKobo(b.totalKobo);
      expect(settled).toBeGreaterThanOrEqual(b.targetSettledKobo);
      expect(b.processingFeeKobo).toBeGreaterThanOrEqual(0);
      expect(b.totalKobo).toBe(b.targetSettledKobo + b.processingFeeKobo);
    }
  });

  it("is all zeros for a zero base", () => {
    expect(computeCheckoutKobo(0)).toEqual({
      baseKobo: 0,
      platformFeeKobo: 0,
      targetSettledKobo: 0,
      totalKobo: 0,
      processingFeeKobo: 0,
    });
  });
});

// The DRIFT GUARD that lived here compared this lib against
// create-paystack-payment's own copy of the money maths. That function was
// retired on 2026-09-02 — superseded by create-payment, no callers, and still
// publicly invocable with a weaker amount check — so there is no second copy
// left to drift from. gatewayMoney.test.ts still cross-checks this lib against
// _shared/gatewayMoney.ts, which is the comparison that now matters.
