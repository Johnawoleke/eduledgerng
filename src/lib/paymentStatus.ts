// Payment lifecycle logic, extracted pure so it can be unit-tested (the actual
// writes happen in the Deno edge functions paystack-webhook / verify-paystack-
// payment, which mirror these rules).

export interface StatusRow {
  status?: string | null;
}

// Only SETTLED payments count toward balances and collection totals. Pending and
// failed Paystack attempts are recorded for visibility but must never reduce a
// balance. Legacy rows have no status value -> treated as settled.
export const isSettledPayment = (p: StatusRow): boolean =>
  p.status !== "pending" && p.status !== "failed";

// The pending -> success/failed state machine. Given the existing row's status
// and the observed outcome, returns the status to WRITE, or null for "no change".
//   • a later success always wins (pending or even a prior failed -> success)
//   • a success is never overwritten by a failure
//   • only a pending attempt is flipped to failed
export const nextPaymentStatus = (
  existing: string | null | undefined,
  outcome: "success" | "failed"
): "success" | "failed" | null => {
  if (outcome === "success") {
    return existing === "success" ? null : "success";
  }
  // outcome === "failed"
  return existing === "pending" ? "failed" : null;
};
