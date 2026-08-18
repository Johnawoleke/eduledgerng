// Reading the fee ledger: what a set of students still owe.
//
// This exists because getting it wrong is silent. sumPaidForFee matches a
// payment line to a fee by id, but LEGACY lines carry no id and fall back to
// matching by NAME (see _shared/feeItems.ts). Those legacy rows are real money
// and still reconcile, so any caller that passes a blank name reads every one
// of them as unpaid — a student who has paid in full looks like they owe
// everything, and a guard built on that number silently lets things through.
//
// Both callers therefore go through here rather than assembling it themselves.
import { sumPaidForFee } from "./feeItems.ts";

// The service-role client's type lives behind an esm.sh import neither
// linter can resolve; recordPayment.ts and notify.ts do the same.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export interface ChargeRow {
  student_id: string;
  class_fee_id: string;
  amount: number;
}
export interface PaymentRow {
  student_id: string;
  items: string[];
  status?: string | null;
}

/** Fee display names by id — required for legacy payment lines to match. */
export const feeNamesByIdFor = async (
  admin: Admin,
  feeIds: string[]
): Promise<Map<string, string>> => {
  const unique = Array.from(new Set(feeIds));
  if (unique.length === 0) return new Map();
  const { data } = await admin.from("class_fees").select("id, name").in("id", unique);
  return new Map(
    (data || []).map((f: { id: string; name: string }) => [f.id, f.name])
  );
};

/**
 * Outstanding balance per student, across every period.
 *
 * Payments are matched by fee id where the line has one and by name where it
 * does not, which is why nameById must be populated from class_fees.
 */
export const outstandingByStudent = (
  charges: ChargeRow[],
  payments: PaymentRow[],
  nameById: Map<string, string>
): Map<string, number> => {
  const settledFor = new Map<string, PaymentRow[]>();
  for (const p of payments || []) {
    if (p.status === "pending" || p.status === "failed") continue;
    const list = settledFor.get(p.student_id) || [];
    list.push(p);
    settledFor.set(p.student_id, list);
  }

  const out = new Map<string, number>();
  for (const c of charges || []) {
    const paid = Math.min(
      sumPaidForFee(settledFor.get(c.student_id) || [], {
        id: c.class_fee_id,
        name: nameById.get(c.class_fee_id) ?? "",
      }),
      Number(c.amount)
    );
    const owed = Math.max(Number(c.amount) - paid, 0);
    out.set(c.student_id, (out.get(c.student_id) || 0) + owed);
  }
  return out;
};

/** Total already paid toward a given set of charges. */
export const paidForCharges = (
  charges: ChargeRow[],
  payments: PaymentRow[],
  nameById: Map<string, string>
): number => {
  const settled = (payments || []).filter(
    (p) => p.status !== "pending" && p.status !== "failed"
  );
  let total = 0;
  for (const c of charges || []) {
    total += Math.min(
      sumPaidForFee(settled, {
        id: c.class_fee_id,
        name: nameById.get(c.class_fee_id) ?? "",
      }),
      Number(c.amount)
    );
  }
  return total;
};
