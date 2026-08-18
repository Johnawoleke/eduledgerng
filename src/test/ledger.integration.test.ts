import { describe, it, expect } from "vitest";
import { isSettledPayment } from "@/lib/paymentStatus";
import { sumPaidForFee, feeStatus, outstandingForFee, encodeFeeItem } from "@/lib/fees";

// The fee ledger (migration 20260818120000).
//
// balance.integration.test.ts pins the OLD model: fees derived by matching
// class_fees against a student's current class, within one period. This file
// pins what replaced it, and specifically the two things that model got wrong:
//
//   1. a promoted student's history must not be re-evaluated against their new
//      class's fee schedule;
//   2. a payment that settles an old term's debt must credit that debt, no
//      matter which period the payment row is stamped with.
//
// Both are computed the same way in student-auth and SchoolAdminDashboard:
// charges for the period, paid summed by fee id across ALL periods.

interface Charge {
  student_id: string;
  class_fee_id: string;
  amount: number;
  session_id: string | null;
  term_id: string | null;
  class_at_charge: string;
}
interface Payment {
  student_id: string;
  items: string[];
  status?: string | null;
  session_id?: string | null;
  term_id?: string | null;
}

/** Mirrors the ledger read: charges scoped to a period, paid matched by fee id. */
const balanceFor = (
  studentId: string,
  charges: Charge[],
  payments: Payment[],
  period?: { session_id?: string; term_id?: string }
) => {
  const mine = charges.filter(
    (c) =>
      c.student_id === studentId &&
      (!period?.session_id || c.session_id === period.session_id) &&
      (!period?.term_id || c.term_id === period.term_id)
  );
  // Deliberately NOT period-filtered — this is the fix.
  const settled = payments.filter((p) => p.student_id === studentId).filter(isSettledPayment);

  const items = mine.map((c) => {
    const paid = Math.min(sumPaidForFee(settled, { id: c.class_fee_id, name: "Tuition" }), c.amount);
    return {
      feeId: c.class_fee_id,
      amount: c.amount,
      paid,
      status: feeStatus(paid, c.amount),
      outstanding: outstandingForFee(c.amount, paid),
    };
  });
  return { items, totalOutstanding: items.reduce((s, i) => s + i.outstanding, 0) };
};

const JSS1_TUITION = "11111111-1111-4111-8111-111111111111";
const JSS2_TUITION = "22222222-2222-4222-8222-222222222222";

const S = "student-1";
const LAST = "session-2025";
const THIS = "session-2026";
const T1 = "term-1";
const T2 = "term-2";

// The student was in JSS1 last year and JSS2 this year. Note the charges record
// the class as at the time — nothing here depends on their CURRENT class.
const charges: Charge[] = [
  { student_id: S, class_fee_id: JSS1_TUITION, amount: 50_000, session_id: LAST, term_id: T1, class_at_charge: "JSS1" },
  { student_id: S, class_fee_id: JSS2_TUITION, amount: 55_000, session_id: THIS, term_id: T2, class_at_charge: "JSS2" },
];

describe("fee ledger", () => {
  it("keeps last year's debt at last year's amount after promotion", () => {
    // Partially paid the JSS1 fee last year.
    const payments: Payment[] = [
      { student_id: S, items: [encodeFeeItem(JSS1_TUITION, "Tuition", 30_000)], status: "success", session_id: LAST, term_id: T1 },
    ];
    const lastYear = balanceFor(S, charges, payments, { session_id: LAST, term_id: T1 });
    expect(lastYear.items).toHaveLength(1);
    // NGN 50,000 — the JSS1 fee. Under the old model this student's current
    // class (JSS2) would have been matched instead, giving 55,000.
    expect(lastYear.items[0]).toMatchObject({ amount: 50_000, paid: 30_000, outstanding: 20_000 });
  });

  it("scopes each period to its own charges", () => {
    const thisYear = balanceFor(S, charges, [], { session_id: THIS, term_id: T2 });
    expect(thisYear.items).toHaveLength(1);
    expect(thisYear.items[0]).toMatchObject({ feeId: JSS2_TUITION, amount: 55_000 });
  });

  it("totals owing across every period when no period is given", () => {
    const all = balanceFor(S, charges, []);
    expect(all.totalOutstanding).toBe(105_000); // 50,000 + 55,000
  });

  it("credits an old debt paid from the CURRENT term's screen", () => {
    // The money bug. The payment settles the JSS1 charge but, because it was
    // initiated from this term's dashboard, could plausibly carry this term's
    // period. Matching by fee id means the stamp cannot misdirect the credit.
    const payments: Payment[] = [
      { student_id: S, items: [encodeFeeItem(JSS1_TUITION, "Tuition", 50_000)], status: "success", session_id: THIS, term_id: T2 },
    ];
    const lastYear = balanceFor(S, charges, payments, { session_id: LAST, term_id: T1 });
    expect(lastYear.items[0]).toMatchObject({ paid: 50_000, status: "paid", outstanding: 0 });

    // ...and it must NOT have reduced this term's balance.
    const thisYear = balanceFor(S, charges, payments, { session_id: THIS, term_id: T2 });
    expect(thisYear.items[0]).toMatchObject({ paid: 0, status: "unpaid", outstanding: 55_000 });
  });

  it("still ignores pending and failed attempts", () => {
    const payments: Payment[] = [
      { student_id: S, items: [encodeFeeItem(JSS2_TUITION, "Tuition", 55_000)], status: "pending" },
      { student_id: S, items: [encodeFeeItem(JSS2_TUITION, "Tuition", 55_000)], status: "failed" },
    ];
    const thisYear = balanceFor(S, charges, payments, { session_id: THIS, term_id: T2 });
    expect(thisYear.items[0]).toMatchObject({ paid: 0, outstanding: 55_000 });
  });

  it("never lets one student's payment touch another's charge", () => {
    const payments: Payment[] = [
      { student_id: "student-2", items: [encodeFeeItem(JSS2_TUITION, "Tuition", 55_000)], status: "success" },
    ];
    const thisYear = balanceFor(S, charges, payments, { session_id: THIS, term_id: T2 });
    expect(thisYear.items[0].paid).toBe(0);
  });
});

describe("payment period stamping", () => {
  // create-payment stamps the payment with the period of the charges it
  // settles, falling back to where it was initiated when one payment spans
  // several periods.
  const derivePeriod = (
    settling: { session_id: string | null; term_id: string | null }[],
    initiatedFrom: { session_id: string | null; term_id: string | null }
  ) => {
    const distinct = Array.from(
      new Set(settling.map((p) => `${p.session_id ?? ""}|${p.term_id ?? ""}`))
    );
    return distinct.length === 1 ? settling[0] : initiatedFrom;
  };

  const thisTerm = { session_id: THIS, term_id: T2 };
  const lastTerm = { session_id: LAST, term_id: T1 };

  it("stamps an arrears-only payment with the OLD term, not the current one", () => {
    expect(derivePeriod([lastTerm], thisTerm)).toEqual(lastTerm);
  });

  it("stamps a current-term payment with the current term", () => {
    expect(derivePeriod([thisTerm], thisTerm)).toEqual(thisTerm);
  });

  it("falls back to where it was initiated when a payment spans periods", () => {
    // No single stamp is correct here; per-fee credit is unaffected either way
    // because reconciliation matches on fee id.
    expect(derivePeriod([lastTerm, thisTerm], thisTerm)).toEqual(thisTerm);
  });
});
