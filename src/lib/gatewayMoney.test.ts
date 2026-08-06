import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GATEWAYS, SQUAD, PAYSTACK, PLATFORM_FEE_RATE,
  rateFeeKobo, gatewayFeeKobo, grossUpKobo, quoteCheckout, selectGateway,
} from "./gatewayMoney";
import { paystackFeeKobo, grossUpKobo as legacyGrossUp } from "./paystackFees";

const NGN = (n: number) => n * 100;

describe("Squad rates", () => {
  it("cards: 1.2% capped ₦1,500", () => {
    expect(gatewayFeeKobo(SQUAD, NGN(10_000))).toBe(NGN(120));
    expect(gatewayFeeKobo(SQUAD, NGN(100_000))).toBe(NGN(1_200));
    expect(gatewayFeeKobo(SQUAD, NGN(1_000_000))).toBe(NGN(1_500)); // cap
  });

  it("beats Paystack standard at every size, which is why it is routed by default", () => {
    for (const amt of [NGN(1_000), NGN(5_000), NGN(50_000), NGN(200_000), NGN(2_000_000)]) {
      expect(gatewayFeeKobo(SQUAD, amt)).toBeLessThanOrEqual(gatewayFeeKobo(PAYSTACK, amt));
    }
  });
});

describe("Paystack rates are unchanged from the live implementation", () => {
  // Paystack is retained for Paystack-for-Education later. Its maths must still
  // match what production charged, or historic rows stop reconciling.
  it("matches paystackFees.paystackFeeKobo", () => {
    for (const amt of [NGN(100), NGN(2_499), NGN(2_500), NGN(50_000), NGN(200_000), NGN(5_000_000)]) {
      expect(gatewayFeeKobo(PAYSTACK, amt)).toBe(paystackFeeKobo(amt));
    }
  });

  it("matches paystackFees.grossUpKobo", () => {
    for (const target of [NGN(1_000), NGN(2_500), NGN(50_000), NGN(500_000), NGN(3_000_000)]) {
      expect(grossUpKobo(PAYSTACK, target)).toBe(legacyGrossUp(target));
    }
  });
});

describe("grossUpKobo — the school is never short-changed", () => {
  const targets = [
    NGN(500), NGN(2_499), NGN(2_500), NGN(2_501), NGN(10_000),
    NGN(50_000), NGN(125_000), NGN(250_000), NGN(1_000_000), NGN(9_999_999),
  ];

  for (const g of Object.values(GATEWAYS)) {
    it(`${g.label}: settles at least the target, and is minimal`, () => {
      for (const target of targets) {
        const total = grossUpKobo(g, target);
        const settled = total - gatewayFeeKobo(g, total);
        expect(settled).toBeGreaterThanOrEqual(target);
        // One kobo less must NOT be enough — so the parent never overpays.
        expect(total - 1 - gatewayFeeKobo(g, total - 1)).toBeLessThan(target);
      }
    });
  }

  it("uses the DEAREST channel, so a cheaper one can only leave a surplus", () => {
    // The parent picks their channel at the gateway's checkout, after we have
    // fixed the amount. Pricing on anything but the worst case would let a
    // card payment under-settle the school.
    const twoChannel = {
      id: "squad" as const,
      label: "test",
      channels: [
        { percent: 0.0025, flat: 0, cap: 100_000 },
        { percent: 0.012, flat: 0, cap: 150_000 },
      ],
    };
    expect(gatewayFeeKobo(twoChannel, NGN(100_000))).toBe(NGN(1_200));
  });

  it("returns 0 for a zero target", () => {
    expect(grossUpKobo(SQUAD, 0)).toBe(0);
  });
});

describe("quoteCheckout", () => {
  it("school gets the exact fee; parent covers platform + gateway", () => {
    const q = quoteCheckout(50_000);
    expect(q.gateway).toBe("squad");
    expect(q.baseKobo).toBe(NGN(50_000));
    expect(q.platformKobo).toBe(NGN(500)); // 1%
    expect(q.targetKobo).toBe(NGN(50_500));
    expect(q.totalKobo - q.processingFeeKobo).toBe(q.targetKobo);
    expect(q.totalKobo).toBeGreaterThan(q.targetKobo);
  });

  it("can be pinned to a specific gateway, for when routing changes", () => {
    expect(quoteCheckout(50_000, PLATFORM_FEE_RATE, "paystack").gateway).toBe("paystack");
  });

  it("a sub-naira fee rounds to nothing and is caught by the caller", () => {
    expect(quoteCheckout(0).totalKobo).toBe(0);
  });
});

describe("selectGateway", () => {
  it("routes everything to Squad today", () => {
    for (const fee of [NGN(500), NGN(50_000), NGN(500_000), NGN(5_000_000)]) {
      expect(selectGateway(fee)).toBe("squad");
    }
  });

  it("only ever returns a gateway we have an implementation for", () => {
    for (const fee of [NGN(1), NGN(1_000_000)]) {
      expect(GATEWAYS[selectGateway(fee)]).toBeDefined();
    }
  });
});

describe("the Deno mirror stays in sync", () => {
  // Edge functions can't import from src/. If these drift, the amount a parent
  // is charged and the amount they're credited stop agreeing.
  const stripHeader = (s: string) => s.replace(/^(\/\/.*\n|\s*\n)+/, "").trim();

  it("has identical logic to src/lib/gatewayMoney.ts", () => {
    const root = resolve(__dirname, "../..");
    const web = readFileSync(resolve(root, "src/lib/gatewayMoney.ts"), "utf8");
    const deno = readFileSync(resolve(root, "supabase/functions/_shared/gatewayMoney.ts"), "utf8");
    expect(stripHeader(deno)).toBe(stripHeader(web));
  });
});
