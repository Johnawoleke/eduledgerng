// Deno mirror of src/lib/gatewayMoney.ts — see that file for the full rationale.
//
// This is the LIVE checkout maths. Edge functions cannot import from src/, so
// this is a hand-kept copy; src/lib/gatewayMoney.test.ts asserts the two stay
// identical below their headers. Regenerate this file from the source rather
// than editing both by hand.

export const PLATFORM_FEE_RATE = 0.01;

export type GatewayId = "paystack";

export interface GatewayRate {
  percent: number;
  /** Flat component in kobo. */
  flat: number;
  /** Below this charge (kobo) the flat component is waived. */
  flatWaivedBelow?: number;
  /** Maximum fee in kobo. */
  cap?: number;
}

export interface GatewayPricing {
  id: GatewayId;
  label: string;
  /**
   * Rates per channel. We cannot know at checkout which channel the parent will
   * pick, so the gross-up uses the DEAREST of these — see grossUpKobo.
   */
  channels: GatewayRate[];
}

// Paystack standard NGN pricing, verified 2026-08-03:
//   1.5% + ₦100, the ₦100 waived under ₦2,500, fee capped at ₦2,000.
//
// If the Education plan (0.7% capped ₦1,500) is approved, add it as a second
// GatewayPricing and give selectGateway() a threshold. Do NOT simply lower
// these numbers: Paystack deducts what YOUR account is actually on, so pricing
// against a rate you have not been approved for makes every school short.
export const PAYSTACK: GatewayPricing = {
  id: "paystack",
  label: "Paystack",
  channels: [{ percent: 0.015, flat: 10_000, flatWaivedBelow: 250_000, cap: 200_000 }],
};

export const GATEWAYS: Record<GatewayId, GatewayPricing> = {
  paystack: PAYSTACK,
};

/** One channel's fee on a charge. */
export const rateFeeKobo = (r: GatewayRate, amountKobo: number): number => {
  if (amountKobo <= 0) return 0;
  let fee = r.percent * amountKobo;
  const waived = r.flatWaivedBelow != null && amountKobo < r.flatWaivedBelow;
  if (!waived) fee += r.flat;
  fee = Math.ceil(fee);
  if (r.cap != null) fee = Math.min(fee, r.cap);
  return Math.max(fee, 0);
};

/**
 * The most a gateway could charge on this amount, across every channel it
 * offers. The parent chooses their channel at the gateway's own checkout, after
 * we have already fixed the amount, so this is the only figure that guarantees
 * the school is never short-changed. If they then pay by a cheaper channel the
 * gateway simply deducts less and the small surplus settles to the school.
 */
export const gatewayFeeKobo = (g: GatewayPricing, amountKobo: number): number =>
  Math.max(...g.channels.map((c) => rateFeeKobo(c, amountKobo)));

/**
 * Smallest total T where T − fee(T) ≥ targetKobo, i.e. what to charge the parent
 * so `targetKobo` still settles. Binary search, so it stays exact for any
 * percent/flat/cap shape and cannot silently break when a rate changes.
 */
export const grossUpKobo = (g: GatewayPricing, targetKobo: number): number => {
  if (targetKobo <= 0) return 0;
  const settles = (t: number) => t - gatewayFeeKobo(g, t);

  let lo = targetKobo;
  let hi = targetKobo + gatewayFeeKobo(g, targetKobo) + 100_000 + 1;
  let guard = 0;
  while (settles(hi) < targetKobo && guard++ < 60) {
    hi = targetKobo + (hi - targetKobo) * 2 + 1;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (settles(mid) >= targetKobo) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Which gateway takes a given payment. Paystack, for everything.
 *
 * This stays a function of the amount rather than a constant because the
 * intended next step is amount-based routing: Paystack for Education (0.7%
 * capped ₦1,500) overtakes the standard rate once the cap binds. When that
 * account is approved, add its rate to GATEWAYS and give this a threshold —
 * the edge functions, the webhook and the ledger already carry the gateway id
 * per payment, so nothing else has to change.
 */
export const selectGateway = (_baseKobo: number): GatewayId => "paystack";

export interface CheckoutQuote {
  gateway: GatewayId;
  /** The fee the school set, and receives in full. */
  baseKobo: number;
  /** The platform's cut. */
  platformKobo: number;
  /** base + platform — what must clear the gateway. */
  targetKobo: number;
  /** What the parent is charged. */
  totalKobo: number;
  /** The gateway's charge, borne by the parent. */
  processingFeeKobo: number;
}

/** Full checkout breakdown for a base fee in NGN. */
export const quoteCheckout = (
  baseAmountNGN: number,
  platformRate = PLATFORM_FEE_RATE,
  gatewayId?: GatewayId
): CheckoutQuote => {
  const baseKobo = Math.round(baseAmountNGN * 100);
  const id = gatewayId ?? selectGateway(baseKobo);
  const g = GATEWAYS[id];
  const platformKobo = Math.round(baseKobo * platformRate);
  const targetKobo = baseKobo + platformKobo;
  const totalKobo = grossUpKobo(g, targetKobo);
  return {
    gateway: id,
    baseKobo,
    platformKobo,
    targetKobo,
    totalKobo,
    processingFeeKobo: Math.max(totalKobo - targetKobo, 0),
  };
};
