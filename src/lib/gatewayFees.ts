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

export type Channel = "card" | "transfer" | "ussd";

export const CHANNELS: { id: Channel; label: string; blurb: string }[] = [
  { id: "card", label: "Card", blurb: "Debit/credit card at checkout" },
  { id: "transfer", label: "Bank transfer", blurb: "Transfer or virtual account" },
  { id: "ussd", label: "USSD", blurb: "*737# style bank codes" },
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
  /** Provider doesn't offer this channel. */
  unsupported?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  note: string;
  /** True when the rate isn't publicly committed and must be negotiated. */
  negotiated?: boolean;
  channels: Record<Channel, ChannelPricing>;
}

// ---------------------------------------------------------------------------
// Published defaults
// ---------------------------------------------------------------------------

const PS_STANDARD: ChannelPricing = {
  percent: 0.015, flat: 10_000, flatWaivedBelow: 250_000, cap: 200_000,
};

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: "paystack",
    name: "Paystack (standard)",
    note: "1.5% + ₦100, ₦100 waived under ₦2,500, capped ₦2,000. What we run today.",
    channels: { card: { ...PS_STANDARD }, transfer: { ...PS_STANDARD }, ussd: { ...PS_STANDARD } },
  },
  {
    id: "paystack-edu",
    name: "Paystack for Education",
    note: "0.7% capped ₦1,500 on cards; flat ₦300 on every other method. Requires approval.",
    channels: {
      card: { percent: 0.007, flat: 0, cap: 150_000 },
      transfer: { percent: 0, flat: 30_000 },
      ussd: { percent: 0, flat: 30_000 },
    },
  },
  {
    id: "paystack-dva",
    name: "Paystack virtual account",
    note: "1% capped ₦300 on dedicated virtual accounts. Transfer channel only.",
    channels: {
      card: { ...PS_STANDARD, unsupported: true },
      transfer: { percent: 0.01, flat: 0, cap: 30_000 },
      ussd: { ...PS_STANDARD, unsupported: true },
    },
  },
  {
    id: "kora",
    name: "Kora (Korapay)",
    note: "1.5% capped ₦2,000 is the commonly quoted rate. Kora says pricing is custom — edit these to model a negotiated deal.",
    negotiated: true,
    channels: {
      card: { percent: 0.015, flat: 0, cap: 200_000 },
      transfer: { percent: 0.015, flat: 0, cap: 200_000 },
      ussd: { percent: 0.015, flat: 0, cap: 200_000 },
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
 * What to charge the payer so that `targetKobo` still reaches us after the
 * gateway takes its cut — when the payer bears `parentShare` of that cut and
 * the school absorbs the rest.
 *
 * Solves for the smallest C where  C − parentShare·fee(C) ≥ target.
 *   parentShare = 1 → C − fee(C) ≥ target   (payer covers everything: today's model)
 *   parentShare = 0 → C ≥ target            (school absorbs the whole fee)
 *
 * Binary search rather than algebra: the left side is non-decreasing in C for
 * any percent/flat/cap shape, so this stays exact and correct even if a provider
 * is given an unusual structure in the UI. Algebraic inversion would need a
 * branch per pricing shape and would break silently on a new one.
 */
export const grossUpKobo = (
  p: ChannelPricing,
  targetKobo: number,
  parentShare = 1
): number => {
  if (targetKobo <= 0) return 0;
  const share = Math.min(Math.max(parentShare, 0), 1);
  const net = (c: number) => c - share * channelFeeKobo(p, c);

  let lo = targetKobo;
  let hi = targetKobo + channelFeeKobo(p, targetKobo) + p.flat + 1;
  let guard = 0;
  while (net(hi) < targetKobo && guard++ < 60) {
    hi = targetKobo + (hi - targetKobo) * 2 + 1;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (net(mid) >= targetKobo) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

export interface ChannelOutcome {
  channel: Channel;
  providerId: string;
  providerName: string;
  unsupported: boolean;
  /** The fee the school set. */
  baseKobo: number;
  /** Platform's cut. */
  platformKobo: number;
  /** What the parent is charged. */
  parentPaysKobo: number;
  /** The gateway's total cut. */
  gatewayFeeKobo: number;
  /** Of that cut, what the parent bears. */
  parentBearsKobo: number;
  /** Of that cut, what the school absorbs. */
  schoolBearsKobo: number;
  /** What actually lands in the school's bank. */
  schoolReceivesKobo: number;
}

export interface ModelInputs {
  baseKobo: number;
  students: number;
  /** Share of payments per channel. Normalised internally. */
  mix: Record<Channel, number>;
  platformRate: number;
  /** 1 = parent covers the whole gateway fee, 0 = school absorbs it. */
  parentShare: number;
  providers: Provider[];
}

export const computeChannel = (
  provider: Provider,
  channel: Channel,
  baseKobo: number,
  platformRate: number,
  parentShare = 1
): ChannelOutcome => {
  const platformKobo = Math.round(baseKobo * platformRate);
  const targetKobo = baseKobo + platformKobo;
  const pricing = provider.channels[channel];
  const parentPaysKobo = grossUpKobo(pricing, targetKobo, parentShare);
  const gatewayFeeKobo = channelFeeKobo(pricing, parentPaysKobo);
  const parentBearsKobo = Math.max(parentPaysKobo - targetKobo, 0);
  return {
    channel,
    providerId: provider.id,
    providerName: provider.name,
    unsupported: !!pricing.unsupported,
    baseKobo,
    platformKobo,
    parentPaysKobo,
    gatewayFeeKobo,
    parentBearsKobo,
    schoolBearsKobo: Math.max(gatewayFeeKobo - parentBearsKobo, 0),
    schoolReceivesKobo: parentPaysKobo - gatewayFeeKobo - platformKobo,
  };
};

// ---------------------------------------------------------------------------
// Routing strategies
// ---------------------------------------------------------------------------

export type Strategy =
  /** Every payment through one provider. */
  | { kind: "single"; providerId: string }
  /** A named provider per channel. */
  | { kind: "split"; byChannel: Record<Channel, string> }
  /** One provider below a fee threshold, another at or above it. */
  | { kind: "threshold"; thresholdKobo: number; belowId: string; aboveId: string }
  /** Per payment, whichever supported provider is cheapest. */
  | { kind: "cheapest" };

export interface StrategyResult {
  label: string;
  detail: string;
  perChannel: Record<Channel, ChannelOutcome>;
  /** Per payment: what the parent is charged. */
  blendedParentKobo: number;
  /** Per payment: what the gateway keeps. */
  blendedGatewayKobo: number;
  /** Per payment: what reaches the school's bank. */
  blendedSchoolReceivesKobo: number;
  /**
   * Per payment: the platform's cut. Identical on every channel and under every
   * strategy, so it never decides which option wins — but the three blended
   * figures plus this one must always sum to what the parent paid, which is what
   * makes the money-flow bar honest.
   */
  blendedPlatformKobo: number;
  totalParentKobo: number;
  totalGatewayKobo: number;
  totalSchoolKobo: number;
  totalPlatformKobo: number;
}

const pick = (providers: Provider[], id: string): Provider =>
  providers.find((p) => p.id === id) ?? providers[0];

const normalisedMix = (mix: Record<Channel, number>): Record<Channel, number> => {
  const total = CHANNELS.reduce((s, c) => s + Math.max(mix[c.id] || 0, 0), 0);
  if (total <= 0) return { card: 1, transfer: 0, ussd: 0 };
  return {
    card: Math.max(mix.card || 0, 0) / total,
    transfer: Math.max(mix.transfer || 0, 0) / total,
    ussd: Math.max(mix.ussd || 0, 0) / total,
  };
};

export const runStrategy = (strategy: Strategy, inputs: ModelInputs): StrategyResult => {
  const { baseKobo, students, platformRate, parentShare, providers } = inputs;
  const share = normalisedMix(inputs.mix);

  const resolve = (channel: Channel): ChannelOutcome => {
    if (strategy.kind === "single") {
      return computeChannel(pick(providers, strategy.providerId), channel, baseKobo, platformRate, parentShare);
    }
    if (strategy.kind === "split") {
      return computeChannel(pick(providers, strategy.byChannel[channel]), channel, baseKobo, platformRate, parentShare);
    }
    if (strategy.kind === "threshold") {
      const id = baseKobo < strategy.thresholdKobo ? strategy.belowId : strategy.aboveId;
      return computeChannel(pick(providers, id), channel, baseKobo, platformRate, parentShare);
    }
    const supported = providers.filter((p) => !p.channels[channel].unsupported);
    const pool = supported.length ? supported : providers;
    return pool
      .map((p) => computeChannel(p, channel, baseKobo, platformRate, parentShare))
      .reduce((best, cur) => (cur.parentPaysKobo < best.parentPaysKobo ? cur : best));
  };

  const perChannel = {
    card: resolve("card"),
    transfer: resolve("transfer"),
    ussd: resolve("ussd"),
  } as Record<Channel, ChannelOutcome>;

  const blend = (fn: (o: ChannelOutcome) => number) =>
    CHANNELS.reduce((s, c) => s + fn(perChannel[c.id]) * share[c.id], 0);

  const blendedParentKobo = blend((o) => o.parentPaysKobo);
  const blendedGatewayKobo = blend((o) => o.gatewayFeeKobo);
  const blendedSchoolReceivesKobo = blend((o) => o.schoolReceivesKobo);

  const name = (id: string) => pick(providers, id).name;
  let label: string;
  let detail: string;
  switch (strategy.kind) {
    case "single":
      label = name(strategy.providerId);
      detail = "Everything through one gateway";
      break;
    case "split":
      label = "Custom split";
      detail = CHANNELS.map((c) => `${c.label.toLowerCase()} → ${name(strategy.byChannel[c.id])}`).join(", ");
      break;
    case "threshold":
      label = "Split by fee size";
      detail = `under ₦${(strategy.thresholdKobo / 100).toLocaleString()} → ${name(strategy.belowId)}, at or above → ${name(strategy.aboveId)}`;
      break;
    default:
      label = "Cheapest per payment";
      detail = CHANNELS.map((c) => `${c.label.toLowerCase()} → ${perChannel[c.id].providerName}`).join(", ");
  }

  return {
    label,
    detail,
    perChannel,
    blendedParentKobo,
    blendedGatewayKobo,
    blendedSchoolReceivesKobo,
    blendedPlatformKobo: Math.round(baseKobo * platformRate),
    totalParentKobo: blendedParentKobo * students,
    totalGatewayKobo: blendedGatewayKobo * students,
    totalSchoolKobo: blendedSchoolReceivesKobo * students,
    totalPlatformKobo: Math.round(baseKobo * platformRate) * students,
  };
};
