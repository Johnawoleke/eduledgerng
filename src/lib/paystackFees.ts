// Canonical Paystack money math for EduLedgerNG checkout.
//
// The school must receive the EXACT fee it set. On top of that the parent pays:
//   • the platform fee (1% of the base fee)  -> the platform's cut
//   • Paystack's gateway/processing fee       -> so the settled amount still
//     covers base + platform fee after Paystack takes its cut.
//
// This module is the single source of truth for that math. An identical copy
// lives in supabase/functions/create-paystack-payment/index.ts (Deno can't
// import from src/); the test suite asserts the two never drift apart.
//
// All amounts are in KOBO (₦1 = 100 kobo) unless a name says NGN.

export const PLATFORM_FEE_RATE = 0.01;

// Paystack NGN pricing: 1.5% + ₦100, the ₦100 waived under ₦2,500, capped at ₦2,000.
export const paystackFeeKobo = (amountKobo: number): number => {
  let fee = 0.015 * amountKobo;
  if (amountKobo >= 250_000) fee += 10_000;
  return Math.min(Math.ceil(fee), 200_000);
};

// Smallest total T such that T - paystackFee(T) >= baseKobo. i.e. the amount to
// charge the parent so that, after Paystack deducts its fee, `baseKobo` still
// settles. Guaranteed to never under-settle the school.
export const grossUpKobo = (baseKobo: number): number => {
  if (baseKobo <= 0) return 0;
  let total =
    baseKobo >= 246_250
      ? Math.ceil((baseKobo + 10_000) / 0.985)
      : Math.ceil(baseKobo / 0.985);
  if (0.015 * total + 10_000 > 200_000) total = baseKobo + 200_000;
  while (total - paystackFeeKobo(total) < baseKobo) total += 100;
  return total;
};

export interface CheckoutBreakdown {
  /** The fee the school set (and must receive), in kobo. */
  baseKobo: number;
  /** Platform's 1% cut, in kobo. */
  platformFeeKobo: number;
  /** What must clear Paystack so the school gets base + platform, in kobo. */
  targetSettledKobo: number;
  /** What the parent is actually charged, in kobo. */
  totalKobo: number;
  /** Paystack's processing fee the parent bears, in kobo. */
  processingFeeKobo: number;
}

// Full checkout breakdown for a base fee given in NGN.
export const computeCheckoutKobo = (
  baseAmountNGN: number,
  platformRate = PLATFORM_FEE_RATE
): CheckoutBreakdown => {
  const baseKobo = Math.round(baseAmountNGN * 100);
  const platformFeeKobo = Math.round(baseKobo * platformRate);
  const targetSettledKobo = baseKobo + platformFeeKobo;
  const totalKobo = grossUpKobo(targetSettledKobo);
  const processingFeeKobo = Math.max(totalKobo - targetSettledKobo, 0);
  return { baseKobo, platformFeeKobo, targetSettledKobo, totalKobo, processingFeeKobo };
};
