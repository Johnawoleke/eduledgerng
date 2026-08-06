// Deno mirror of src/lib/gatewayMoney.ts — see that file for the full rationale.
//
// This is the LIVE checkout maths. Edge functions cannot import from src/, so
// this is a hand-kept copy; src/lib/gatewayMoney.test.ts asserts the two stay
// identical below their headers. Regenerate this file from the source rather
// than editing both by hand.

export const PLATFORM_FEE_RATE = 0.01;

export type GatewayId = "squad" | "paystack";

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

// Squad (HabariPay), verified 2026-08-04 from squadco.com/pricing.
//   cards / payment links   1.2% capped ₦1,500
//   virtual account         0.25% capped ₦1,000
// The virtual-account rate is NOT yet confirmed to apply to the one-time
// accounts used at checkout — Squad has not published that, and it is gated
// behind their "select registered businesses" verification. Until it is
// confirmed, only the card rate is listed, so the gross-up cannot under-charge.
export const SQUAD: GatewayPricing = {
  id: "squad",
  label: "Squad",
  channels: [{ percent: 0.012, flat: 0, cap: 150_000 }],
};

// Paystack standard, verified 2026-08-03. Kept so the platform can fall back to
// it, and so the Paystack-for-Education rate can be slotted in later without
// touching anything but this constant and the routing rule below.
export const PAYSTACK: GatewayPricing = {
  id: "paystack",
  label: "Paystack",
  channels: [{ percent: 0.015, flat: 10_000, flatWaivedBelow: 250_000, cap: 200_000 }],
};

export const GATEWAYS: Record<GatewayId, GatewayPricing> = {
  squad: SQUAD,
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
 * Which gateway takes a given payment.
 *
 * Today: Squad for everything. Its 1.2% beats Paystack's 1.5% + ₦100 at every
 * fee size, so there is no amount at which standard Paystack wins.
 *
 * This exists as a function rather than a constant because the intended next
 * step is amount-based routing — Paystack for Education (0.7% capped ₦1,500)
 * overtakes Squad's 1.2% above roughly ₦125,000, once the cap binds. When that
 * account is approved, add its rate to GATEWAYS and give this a threshold; the
 * edge functions, the webhooks and the ledger all already carry the gateway id
 * per payment, so nothing else has to change.
 */
export const selectGateway = (_baseKobo: number): GatewayId => "squad";

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
