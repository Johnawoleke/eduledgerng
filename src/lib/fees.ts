// Fee/paid calculations, extracted pure so the money math around balances is
// unit-tested. Mirrors the logic used in student-auth, SchoolAdminDashboard,
// and create-paystack-payment.

export interface ItemRow {
  items?: string[] | null;
}

// Sum how much has been paid toward a specific fee name across payment rows.
// Payment items are "FeeName|amount" strings; the amount is everything after the
// LAST "|", so fee names may themselves contain a "|".
export const sumPaidForFee = (payments: ItemRow[], feeName: string): number => {
  let total = 0;
  for (const p of payments || []) {
    for (const raw of p.items || []) {
      const pipe = raw.lastIndexOf("|");
      if (pipe <= 0) continue;
      const name = raw.substring(0, pipe);
      const amount = Number(raw.substring(pipe + 1));
      if (name === feeName && !Number.isNaN(amount)) total += amount;
    }
  }
  return total;
};

// A fee's status for a student, given how much they've paid toward it. Paid is
// clamped to the fee amount by callers, but this is robust to over-payment too.
export const feeStatus = (paid: number, amount: number): "paid" | "partial" | "unpaid" =>
  paid >= amount ? "paid" : paid > 0 ? "partial" : "unpaid";

// How many students a fee applies to. A fee targets one class, or "ALL".
export const countStudentsInClass = (
  students: { class: string }[],
  classTarget: string
): number => (students || []).filter((s) => classTarget === "ALL" || s.class === classTarget).length;

// The amount still owed on a fee (never negative, and a payment can't reduce it
// below zero even if items over-count).
export const outstandingForFee = (amount: number, paid: number): number =>
  Math.max(amount - Math.min(paid, amount), 0);
