// Payment line-item encoding.
//
// A `payments.items` entry records how much of one fee a payment covered.
//
//   legacy format:  "FeeName|amount"
//   current format: "<fee uuid>|FeeName|amount"
//
// The legacy format keyed reconciliation on the fee NAME, which silently
// cross-credits two different fees that share a name in the same period — the
// common case being a class-specific fee and an "ALL" fee both called e.g.
// "Transport". Paying one marked the other settled, and the school lost the
// difference. New items carry the fee's uuid so matching is exact.
//
// Both formats must keep parsing forever: rows written before this change are
// real money and still have to reconcile. An item with no id falls back to
// name matching, exactly as before.
//
// Mirrored for Deno in supabase/functions/_shared/feeItems.ts — the two copies
// are kept in sync by src/lib/feeItems.test.ts.

export interface ParsedFeeItem {
  feeId: string | null;
  name: string;
  amount: number;
}

export interface ItemRow {
  items?: string[] | null;
}

const UUID_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([\s\S]*)$/i;

// Encode one line item. Fee names may contain "|", which is why the amount is
// always read from the LAST separator and the id from the FIRST.
export const encodeFeeItem = (feeId: string | null | undefined, name: string, amount: number): string =>
  feeId ? `${feeId}|${name}|${amount}` : `${name}|${amount}`;

export const parseFeeItem = (raw: string): ParsedFeeItem | null => {
  if (!raw) return null;
  const pipe = raw.lastIndexOf("|");
  if (pipe <= 0) return null;

  const amount = Number(raw.substring(pipe + 1));
  if (Number.isNaN(amount)) return null;

  const head = raw.substring(0, pipe);
  const withId = UUID_PREFIX.exec(head);
  if (withId) {
    return { feeId: withId[1], name: withId[2], amount };
  }
  return { feeId: null, name: head, amount };
};

export const parseFeeItems = (items: string[] | null | undefined): ParsedFeeItem[] => {
  const out: ParsedFeeItem[] = [];
  for (const raw of items || []) {
    const parsed = parseFeeItem(raw);
    if (parsed) out.push(parsed);
  }
  return out;
};

// Sum what has been paid toward one specific fee across payment rows.
//
// An item that carries a fee id matches ONLY that id — this is what stops two
// same-named fees from cross-crediting. An item without one (written before the
// format change) falls back to matching on name.
export const sumPaidForFee = (
  payments: ItemRow[],
  fee: { id?: string | null; name: string }
): number => {
  let total = 0;
  for (const p of payments || []) {
    for (const parsed of parseFeeItems(p.items)) {
      const matches = parsed.feeId
        ? fee.id != null && parsed.feeId.toLowerCase() === String(fee.id).toLowerCase()
        : parsed.name === fee.name;
      if (matches) total += parsed.amount;
    }
  }
  return total;
};

export interface PayableItem {
  fee_item_id?: string;
  name: string;
  amount: number;
}

/**
 * Spread the money that ACTUALLY arrived across the fees it was meant for.
 *
 * A payer can send less than the amount agreed at checkout — with Paystack that
 * means a bank transfer to the one-off account for a different figure, since
 * card, USSD and QR all fix the amount we set. The old behaviour credited
 * nothing at all in that case: the money was collected and settled to the
 * school, while the student's dashboard still showed the full amount owed and
 * nothing on any screen explained why. Money held and not credited.
 *
 * Refunding it instead sounds fairer and is not: Paystack does not return its
 * transaction fee on a refund, so every occurrence would cost the school or the
 * platform real money, and the payer waits days for a reversal of a payment
 * they meant to make.
 *
 * So credit what arrived. `paid / expected` is the fraction of the bill they
 * honoured, and they get that fraction of their fees. The remainder stays owing
 * and they can pay it whenever. Nobody is charged anything, nothing is held.
 *
 * The fraction is applied to the BASE fees, not to the grossed-up total, and it
 * is floored — so this can never credit more than arrived, which is the
 * property that matters. It is approximate in the school's favour by well under
 * 1%: the platform's cut and the gateway's fee are not perfectly proportional
 * (there is a flat component and a cap), so the school nets slightly less than
 * the fraction suggests. Exactness would require knowing Paystack's actual
 * deduction at settle time, which the webhook does not carry.
 *
 * Fees are filled in the order they were selected, each to the full amount,
 * until the money runs out. Spreading it thinly across all of them instead
 * would leave every fee part-paid and none of them settled, which is worse for
 * a school chasing a specific fee.
 */
export const apportionPaidItems = (
  items: PayableItem[] | null | undefined,
  paidKobo: number,
  expectedKobo: number
): PayableItem[] => {
  const real = (items || [])
    .map((i) => ({ ...i, amount: Math.max(Number(i.amount) || 0, 0) }))
    .filter((i) => i.amount > 0);

  const fullBase = real.reduce((sum, i) => sum + i.amount, 0);
  if (fullBase <= 0) return [];

  // Not a shortfall: pay everything as billed. Overpayment credits the fees in
  // full too, and the surplus settles to the school.
  if (!Number.isFinite(paidKobo) || !Number.isFinite(expectedKobo) ||
      expectedKobo <= 0 || paidKobo >= expectedKobo) {
    return real;
  }
  if (paidKobo <= 0) return [];

  let left = Math.floor((fullBase * paidKobo) / expectedKobo);

  const out: PayableItem[] = [];
  for (const item of real) {
    if (left <= 0) break;
    const amount = Math.min(item.amount, left);
    left -= amount;
    out.push({ ...item, amount });
  }
  return out;
};
