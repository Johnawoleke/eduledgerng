// Fee/paid calculations, extracted pure so the money math around balances is
// unit-tested. Mirrors the logic used in student-auth, SchoolAdminDashboard,
// and create-paystack-payment.

// Payment line-item parsing and per-fee totals live in ./feeItems, which owns
// both the current "<fee uuid>|FeeName|amount" encoding and the legacy
// "FeeName|amount" one. Re-exported here so existing callers keep one import.
export type { ItemRow, ParsedFeeItem } from "./feeItems";
export { sumPaidForFee, parseFeeItem, parseFeeItems, encodeFeeItem } from "./feeItems";

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
