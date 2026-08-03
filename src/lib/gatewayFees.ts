// Gateway cost modelling — for the internal comparison lab at /gateway-lab.
//
// This is a MODELLING library, deliberately separate from src/lib/paystackFees.ts.
// That file is the live checkout math (mirrored into the Deno edge function and
// asserted identical by tests); nothing here touches a real payment.
//
// Published rates, verified 2026-08-03 — treat them as defaults to model with,
// not as contract terms. Paystack Education must be applied for, and Kora's
// public position is that pricing is quote-based, so its numbers are the ones
// most worth editing in the UI.
//
// All amounts are in KOBO (₦1 = 100 kobo).

export type Channel = "card" | "transfer";

export const CHANNELS: { id: Channel; label: string; blurb: string }[] = [
  { id: "card", label: "Card", blurb: "Debit/credit card at checkout" },
  { id: "transfer", label: "Bank transfer", blurb: "Transfer / virtual account / USSD" },
];

export interface ChannelPricing {
  /** Proportional rate, e.g. 0.015 for 1.5%. */
  percent: number;
  /** Flat component in kobo, e.g. 10_000 for ₦100. */
  flat: number;
  /** Below this amount (kobo) the flat component is waived. */
  flatWaivedBelow?: number;
  /** Maximum fee in kobo. Undefined = uncapped. */
  cap?: number;
}

export interface Provider {
  id: string;
  name: string;
  /** Shown under the name in the UI. */
  note: string;
  /** True when the rate isn't publicly committed and must be negotiated. */
  negotiated?: boolean;
  channels: Record<Channel, ChannelPricing>;
}

// ---------------------------------------------------------------------------
// Published defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: "paystack",
    name: "Paystack (standard)",
    note: "1.5% + ₦100, ₦100 waived under ₦2,500, capped ₦2,000. What we run today.",
    channels: {
      card: { percent: 0.015, flat: 10_000, flatWaivedBelow: 250_000, cap: 200_000 },
      transfer: { percent: 0.015, flat: 10_000, flatWaivedBelow: 250_000, cap: 200_000 },
    },
  },
  {
    id: "paystack-edu",
    name: "Paystack for Education",
    note: "0.7% capped ₦1,500 on cards; flat ₦300 on every other method. Requires approval.",
    channels: {
      card: { percent: 0.007, flat: 0, cap: 150_000 },
      transfer: { percent: 0, flat: 30_000 },
    },
  },
  {
    id: "paystack-dva",
    name: "Paystack virtual account",
    note: "1% capped ₦300 on dedicated virtual accounts. Transfer-only.",
    channels: {
      card: { percent: 0.015, flat: 10_000, flatWaivedBelow: 250_000, cap: 200_000 },
      transfer: { percent: 0.01, flat: 0, cap: 30_000 },
    },
  },
  {
    id: "kora",
    name: "Kora (Korapay)",
    note: "1.5% capped ₦2,000 is the commonly quoted rate. Kora says pricing is custom — edit these to model your negotiated deal.",
    negotiated: true,
    channels: {
      card: { percent: 0.015, flat: 0, cap: 200_000 },
      transfer: { percent: 0.015, flat: 0, cap: 200_000 },
    },
  },
];

// ---------------------------------------------------------------------------
// Core maths
// ---------------------------------------------------------------------------

/** The gateway's fee on a charge of `amountKobo`. */
export const channelFeeKobo = (p: ChannelPricing, amountKobo: number): number => {
  if (amountKobo <= 0) return 0;
  let fee = p.percent * amountKobo;
  const waived = p.flatWaivedBelow != null && amountKobo < p.flatWaivedBelow;
  if (!waived) fee += p.flat;
  fee = Math.ceil(fee);
  if (p.cap != null) fee = Math.min(fee, p.cap);
  return Math.max(fee, 0);
};

/**
 * Smallest total T such that T - fee(T) >= targetKobo — i.e. what to charge the
 * payer so the target still settles after the gateway takes its cut.
 *
 * Binary search rather than algebra: `T - fee(T)` is non-decreasing in T for any
 * percent/flat/cap shape, so the search is exact and stays correct if a provider
 * is given an unusual structure in the UI. Algebraic inversion would need a
 * separate branch per pricing shape and silently break on a new one.
 */
export const grossUpKobo = (p: ChannelPricing, targetKobo: number): number => {
  if (targetKobo <= 0) return 0;
  const settles = (t: number) => t - channelFeeKobo(p, t);

  let lo = targetKobo;
  let hi = targetKobo + channelFeeKobo(p, targetKobo) + p.flat + 1;
  // Expand until the upper bound genuinely settles enough (uncapped high-percent
  // pricing can need more headroom than one fee's worth).
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

export interface ChannelOutcome {
  channel: Channel;
  providerId: string;
  providerName: string;
  /** The fee the school set. */
  baseKobo: number;
  /** Platform's cut. */
  platformKobo: number;
  /** What must clear the gateway = base + platform. */
  targetKobo: number;
  /** What the parent is charged. */
  parentPaysKobo: number;
  /** The gateway's cut, borne by the parent. */
  gatewayFeeKobo: number;
}

export const computeChannel = (
  provider: Provider,
  channel: Channel,
  baseKobo: number,
  platformRate: number
): ChannelOutcome => {
  const platformKobo = Math.round(baseKobo * platformRate);
  const targetKobo = baseKobo + platformKobo;
  const pricing = provider.channels[channel];
  const parentPaysKobo = grossUpKobo(pricing, targetKobo);
  return {
    channel,
    providerId: provider.id,
    providerName: provider.name,
    baseKobo,
    platformKobo,
    targetKobo,
    parentPaysKobo,
    gatewayFeeKobo: Math.max(parentPaysKobo - targetKobo, 0),
  };
};

// ---------------------------------------------------------------------------
// Routing strategies
// ---------------------------------------------------------------------------

export type Strategy =
  /** Every payment through one provider. */
  | { kind: "single"; providerId: string }
  /** Cards to one provider, transfers to another. */
  | { kind: "split"; cardProviderId: string; transferProviderId: string }
  /** Per transaction, whichever provider is cheapest for that channel+amount. */
  | { kind: "cheapest" };

export interface StrategyResult {
  label: string;
  detail: string;
  /** Per channel, the winning outcome. */
  perChannel: Record<Channel, ChannelOutcome>;
  /** Mix-weighted average of what a parent pays. */
  blendedParentKobo: number;
  /** Mix-weighted average gateway fee. */
  blendedGatewayKobo: number;
  /** Across the whole cohort. */
  totalParentKobo: number;
  totalGatewayKobo: number;
  totalSchoolKobo: number;
  totalPlatformKobo: number;
}

export interface ModelInputs {
  baseKobo: number;
  students: number;
  /** Share of payments made by card, 0..1. The rest are transfers. */
  cardShare: number;
  platformRate: number;
  providers: Provider[];
}

const pick = (providers: Provider[], id: string): Provider =>
  providers.find((p) => p.id === id) ?? providers[0];

export const runStrategy = (strategy: Strategy, inputs: ModelInputs): StrategyResult => {
  const { baseKobo, students, cardShare, platformRate, providers } = inputs;

  const resolve = (channel: Channel): ChannelOutcome => {
    if (strategy.kind === "single") {
      return computeChannel(pick(providers, strategy.providerId), channel, baseKobo, platformRate);
    }
    if (strategy.kind === "split") {
      const id = channel === "card" ? strategy.cardProviderId : strategy.transferProviderId;
      return computeChannel(pick(providers, id), channel, baseKobo, platformRate);
    }
    // cheapest: evaluate every provider for this channel and take the lowest
    // parent charge, tie-breaking on the provider listed first.
    return providers
      .map((p) => computeChannel(p, channel, baseKobo, platformRate))
      .reduce((best, cur) => (cur.parentPaysKobo < best.parentPaysKobo ? cur : best));
  };

  const perChannel = { card: resolve("card"), transfer: resolve("transfer") };

  const share: Record<Channel, number> = {
    card: Math.min(Math.max(cardShare, 0), 1),
    transfer: 1 - Math.min(Math.max(cardShare, 0), 1),
  };

  const blendedParentKobo =
    perChannel.card.parentPaysKobo * share.card +
    perChannel.transfer.parentPaysKobo * share.transfer;
  const blendedGatewayKobo =
    perChannel.card.gatewayFeeKobo * share.card +
    perChannel.transfer.gatewayFeeKobo * share.transfer;

  const label =
    strategy.kind === "single"
      ? pick(providers, strategy.providerId).name
      : strategy.kind === "split"
        ? `${pick(providers, strategy.cardProviderId).name} + ${pick(providers, strategy.transferProviderId).name}`
        : "Cheapest per payment";

  const detail =
    strategy.kind === "single"
      ? "Everything through one gateway"
      : strategy.kind === "split"
        ? `Cards via ${pick(providers, strategy.cardProviderId).name}, transfers via ${pick(providers, strategy.transferProviderId).name}`
        : `Cards via ${perChannel.card.providerName}, transfers via ${perChannel.transfer.providerName}`;

  return {
    label,
    detail,
    perChannel,
    blendedParentKobo,
    blendedGatewayKobo,
    totalParentKobo: blendedParentKobo * students,
    totalGatewayKobo: blendedGatewayKobo * students,
    totalSchoolKobo: baseKobo * students,
    totalPlatformKobo: Math.round(baseKobo * platformRate) * students,
  };
};

/** Every single-provider strategy, plus the split and cheapest options. */
export const buildStrategies = (providers: Provider[]): Strategy[] => {
  const singles: Strategy[] = providers.map((p) => ({ kind: "single", providerId: p.id }));
  return [...singles, { kind: "cheapest" }];
};
