import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROVIDERS,
  channelFeeKobo,
  grossUpKobo,
  computeChannel,
  runStrategy,
  type Provider,
} from "./gatewayFees";
import { paystackFeeKobo, grossUpKobo as liveGrossUp } from "./paystackFees";

const provider = (id: string): Provider => DEFAULT_PROVIDERS.find((p) => p.id === id)!;
const NGN = (n: number) => n * 100;

describe("channelFeeKobo — published rates", () => {
  const ps = provider("paystack").channels.card;

  it("Paystack standard: 1.5% + ₦100", () => {
    expect(channelFeeKobo(ps, NGN(10_000))).toBe(NGN(250)); // 150 + 100
  });

  it("Paystack standard: ₦100 waived under ₦2,500", () => {
    expect(channelFeeKobo(ps, NGN(2_000))).toBe(NGN(30)); // 1.5% only
    expect(channelFeeKobo(ps, NGN(2_500))).toBe(NGN(137.5)); // 1.5% + 100
  });

  it("Paystack standard: capped at ₦2,000", () => {
    expect(channelFeeKobo(ps, NGN(1_000_000))).toBe(NGN(2_000));
    expect(channelFeeKobo(ps, NGN(50_000_000))).toBe(NGN(2_000));
  });

  it("Paystack Education card: 0.7% capped ₦1,500", () => {
    const edu = provider("paystack-edu").channels.card;
    expect(channelFeeKobo(edu, NGN(100_000))).toBe(NGN(700));
    expect(channelFeeKobo(edu, NGN(1_000_000))).toBe(NGN(1_500)); // cap
  });

  it("Paystack Education transfer: flat ₦300 at any size", () => {
    const edu = provider("paystack-edu").channels.transfer;
    expect(channelFeeKobo(edu, NGN(5_000))).toBe(NGN(300));
    expect(channelFeeKobo(edu, NGN(500_000))).toBe(NGN(300));
  });

  it("Paystack virtual account: 1% capped ₦300", () => {
    const dva = provider("paystack-dva").channels.transfer;
    expect(channelFeeKobo(dva, NGN(10_000))).toBe(NGN(100));
    expect(channelFeeKobo(dva, NGN(100_000))).toBe(NGN(300)); // cap
  });

  it("Kora: 1.5% capped ₦2,000, no flat", () => {
    const k = provider("kora").channels.card;
    expect(channelFeeKobo(k, NGN(10_000))).toBe(NGN(150));
    expect(channelFeeKobo(k, NGN(1_000_000))).toBe(NGN(2_000));
  });

  it("is zero for a zero or negative charge", () => {
    expect(channelFeeKobo(ps, 0)).toBe(0);
    expect(channelFeeKobo(ps, -500)).toBe(0);
  });
});

describe("grossUpKobo — must never under-settle", () => {
  const targets = [
    NGN(500), NGN(2_499), NGN(2_500), NGN(2_501), NGN(10_000),
    NGN(50_000), NGN(132_500), NGN(250_000), NGN(1_000_000), NGN(9_999_999),
  ];

  for (const p of DEFAULT_PROVIDERS) {
    for (const channel of ["card", "transfer"] as const) {
      it(`${p.name} / ${channel}: settles at least the target, and is minimal`, () => {
        for (const target of targets) {
          const pricing = p.channels[channel];
          const total = grossUpKobo(pricing, target);
          const settled = total - channelFeeKobo(pricing, total);

          // Never short-changes the school...
          expect(settled).toBeGreaterThanOrEqual(target);
          // ...and never overcharges the parent by even one kobo more than needed.
          const oneLess = total - 1;
          expect(oneLess - channelFeeKobo(pricing, oneLess)).toBeLessThan(target);
        }
      });
    }
  }

  it("returns 0 for a zero target", () => {
    expect(grossUpKobo(provider("paystack").channels.card, 0)).toBe(0);
  });
});

describe("agrees with the LIVE checkout math for Paystack standard", () => {
  // The model must reproduce what production actually charges, or the lab is
  // comparing against a fiction.
  it("fee function matches paystackFees.paystackFeeKobo", () => {
    const ps = provider("paystack").channels.card;
    for (const amt of [NGN(100), NGN(2_499), NGN(2_500), NGN(50_000), NGN(200_000), NGN(5_000_000)]) {
      expect(channelFeeKobo(ps, amt)).toBe(paystackFeeKobo(amt));
    }
  });

  it("gross-up matches paystackFees.grossUpKobo", () => {
    const ps = provider("paystack").channels.card;
    for (const target of [NGN(1_000), NGN(2_500), NGN(50_000), NGN(500_000), NGN(3_000_000)]) {
      expect(grossUpKobo(ps, target)).toBe(liveGrossUp(target));
    }
  });
});

describe("computeChannel — who bears the gateway fee", () => {
  it("parentShare = 1 (today): school gets the exact fee, parent covers everything", () => {
    const out = computeChannel(provider("paystack"), "card", NGN(50_000), 0.01, 1);
    expect(out.baseKobo).toBe(NGN(50_000));
    expect(out.platformKobo).toBe(NGN(500));
    expect(out.schoolReceivesKobo).toBe(NGN(50_000));
    expect(out.schoolBearsKobo).toBe(0);
    expect(out.parentBearsKobo).toBe(out.gatewayFeeKobo);
    expect(out.parentPaysKobo).toBe(NGN(50_500) + out.gatewayFeeKobo);
  });

  it("parentShare = 0: parent pays fee + platform only, school absorbs the gateway cut", () => {
    const out = computeChannel(provider("paystack"), "card", NGN(50_000), 0.01, 0);
    expect(out.parentPaysKobo).toBe(NGN(50_500));
    expect(out.parentBearsKobo).toBe(0);
    expect(out.schoolBearsKobo).toBe(out.gatewayFeeKobo);
    expect(out.schoolReceivesKobo).toBe(NGN(50_000) - out.gatewayFeeKobo);
  });

  it("a half share splits the cut, and the pieces always reconcile", () => {
    for (const share of [0, 0.25, 0.5, 0.75, 1]) {
      const out = computeChannel(provider("paystack"), "card", NGN(50_000), 0.01, share);
      // Every naira is accounted for: what the parent pays = what the school
      // receives + the platform's cut + the gateway's cut.
      expect(out.schoolReceivesKobo + out.platformKobo + out.gatewayFeeKobo)
        .toBe(out.parentPaysKobo);
      expect(out.parentBearsKobo + out.schoolBearsKobo).toBe(out.gatewayFeeKobo);
    }
  });

  it("marks an unsupported channel", () => {
    expect(computeChannel(provider("paystack-dva"), "card", NGN(10_000), 0.01).unsupported).toBe(true);
    expect(computeChannel(provider("paystack-dva"), "transfer", NGN(10_000), 0.01).unsupported).toBe(false);
  });
});

describe("routing strategies", () => {
  const inputs = {
    baseKobo: NGN(100_000),
    students: 200,
    mix: { card: 50, transfer: 50, ussd: 0 },
    platformRate: 0.01,
    providers: DEFAULT_PROVIDERS,
    parentShare: 1,
  };

  it("Education beats standard on a large fee", () => {
    const std = runStrategy({ kind: "single", providerId: "paystack" }, inputs);
    const edu = runStrategy({ kind: "single", providerId: "paystack-edu" }, inputs);
    expect(edu.blendedGatewayKobo).toBeLessThan(std.blendedGatewayKobo);
  });

  it("cheapest-per-payment is never worse than any single provider", () => {
    const cheapest = runStrategy({ kind: "cheapest" }, inputs);
    for (const p of DEFAULT_PROVIDERS) {
      const single = runStrategy({ kind: "single", providerId: p.id }, inputs);
      expect(cheapest.blendedGatewayKobo).toBeLessThanOrEqual(single.blendedGatewayKobo + 0.0001);
    }
  });

  it("split routing picks the named provider per channel", () => {
    const split = runStrategy(
      { kind: "split", byChannel: { card: "paystack-edu", transfer: "paystack-dva", ussd: "paystack-edu" } },
      inputs
    );
    expect(split.perChannel.card.providerId).toBe("paystack-edu");
    expect(split.perChannel.transfer.providerId).toBe("paystack-dva");
  });

  it("the school's total never depends on the routing choice", () => {
    const a = runStrategy({ kind: "single", providerId: "paystack" }, inputs);
    const b = runStrategy({ kind: "cheapest" }, inputs);
    expect(a.totalSchoolKobo).toBe(b.totalSchoolKobo);
    expect(a.totalPlatformKobo).toBe(b.totalPlatformKobo);
  });

  it("threshold routing switches provider at the fee size", () => {
    const rule = { kind: "threshold" as const, thresholdKobo: NGN(30_000), belowId: "paystack-dva", aboveId: "paystack-edu" };
    const small = runStrategy(rule, { ...inputs, baseKobo: NGN(10_000) });
    const large = runStrategy(rule, { ...inputs, baseKobo: NGN(100_000) });
    expect(small.perChannel.transfer.providerId).toBe("paystack-dva");
    expect(large.perChannel.transfer.providerId).toBe("paystack-edu");
  });

  it("cheapest routing skips providers that don't offer the channel", () => {
    // paystack-dva is transfer-only, so it must never win the card channel.
    const r = runStrategy({ kind: "cheapest" }, inputs);
    expect(r.perChannel.card.providerId).not.toBe("paystack-dva");
    expect(r.perChannel.card.unsupported).toBe(false);
  });

  it("the channel mix is normalised, so it need not sum to 100", () => {
    const a = runStrategy({ kind: "single", providerId: "paystack" }, { ...inputs, mix: { card: 1, transfer: 1, ussd: 0 } });
    const b = runStrategy({ kind: "single", providerId: "paystack" }, { ...inputs, mix: { card: 50, transfer: 50, ussd: 0 } });
    expect(a.blendedGatewayKobo).toBeCloseTo(b.blendedGatewayKobo, 6);
  });

  it("USSD is modelled and Education's flat ₦300 applies to it", () => {
    const edu = runStrategy({ kind: "single", providerId: "paystack-edu" }, { ...inputs, mix: { card: 0, transfer: 0, ussd: 100 } });
    expect(edu.blendedGatewayKobo).toBe(NGN(300));
  });

  it("card share of 0 or 1 uses only that channel", () => {
    const allCard = runStrategy({ kind: "single", providerId: "paystack-edu" }, { ...inputs, mix: { card: 100, transfer: 0, ussd: 0 } });
    const allTransfer = runStrategy({ kind: "single", providerId: "paystack-edu" }, { ...inputs, mix: { card: 0, transfer: 100, ussd: 0 } });
    expect(allCard.blendedGatewayKobo).toBe(allCard.perChannel.card.gatewayFeeKobo);
    expect(allTransfer.blendedGatewayKobo).toBe(allTransfer.perChannel.transfer.gatewayFeeKobo);
  });
});
