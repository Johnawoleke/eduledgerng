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
