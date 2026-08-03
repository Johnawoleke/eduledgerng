// Deno mirror of src/lib/feeItems.ts — see that file for the full rationale.
//
//   legacy format:  "FeeName|amount"
//   current format: "<fee uuid>|FeeName|amount"
//
// Edge functions cannot import from src/, so this is a hand-kept copy. The unit
// test src/lib/feeItems.test.ts asserts the two files stay identical below their
// header comments, so a change to one fails the build until the other follows.

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
