import { describe, it, expect } from "vitest";
import { isSettledPayment } from "@/lib/paymentStatus";
import { sumPaidForFee, feeStatus, outstandingForFee } from "@/lib/fees";

// Integration of the money logic that computes a student's outstanding balance.
// This mirrors what the student-auth edge function does server-side: for each
// PUBLISHED class fee, sum the SETTLED payments toward it, clamp to the fee
// amount, and derive status + outstanding. Verifying it here guards the balance
// math end-to-end (pending/failed attempts must never reduce what's owed).

interface Fee { name: string; amount: number; status: "published" | "pending" }
interface Payment { items: string[]; status?: string | null }

const computeBalance = (fees: Fee[], payments: Payment[]) => {
  const published = fees.filter((f) => f.status === "published");
  const settled = payments.filter(isSettledPayment);
  const items = published.map((f) => {
    const paid = Math.min(sumPaidForFee(settled, f.name), f.amount);
    return {
      name: f.name,
      amount: f.amount,
      paid,
      status: feeStatus(paid, f.amount),
      outstanding: outstandingForFee(f.amount, paid),
    };
  });
  const totalOutstanding = items.reduce((s, i) => s + i.outstanding, 0);
  return { items, totalOutstanding };
};

describe("student outstanding balance (integration of the money logic)", () => {
  it("counts only settled payments; pending & failed never reduce the balance", () => {
    const fees: Fee[] = [
      { name: "Tuition", amount: 5000, status: "published" },
      { name: "Books", amount: 2000, status: "published" },
    ];
    const payments: Payment[] = [
      { items: ["Tuition|3000"], status: "success" }, // counts
      { items: ["Tuition|2000"], status: "pending" }, // must NOT count
      { items: ["Books|2000"], status: "failed" }, //   must NOT count
    ];
    const { items, totalOutstanding } = computeBalance(fees, payments);
    expect(items.find((i) => i.name === "Tuition")).toMatchObject({ paid: 3000, status: "partial", outstanding: 2000 });
    expect(items.find((i) => i.name === "Books")).toMatchObject({ paid: 0, status: "unpaid", outstanding: 2000 });
    expect(totalOutstanding).toBe(4000);
  });

  it("ignores PENDING (unpublished) fees entirely — students never see/owe them", () => {
    const fees: Fee[] = [
      { name: "Tuition", amount: 5000, status: "published" },
      { name: "Excursion", amount: 8000, status: "pending" }, // not approved -> invisible
    ];
    const { items, totalOutstanding } = computeBalance(fees, []);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Tuition");
    expect(totalOutstanding).toBe(5000);
  });

  it("marks a fee paid and clamps over-payment (balance never goes negative)", () => {
    const fees: Fee[] = [{ name: "Tuition", amount: 5000, status: "published" }];
    const payments: Payment[] = [
      { items: ["Tuition|3000"], status: "success" },
      { items: ["Tuition|4000"], status: "success" }, // total 7000 > 5000
    ];
    const { items, totalOutstanding } = computeBalance(fees, payments);
    expect(items[0]).toMatchObject({ paid: 5000, status: "paid", outstanding: 0 });
    expect(totalOutstanding).toBe(0);
  });

  it("legacy payments with no status still count as settled", () => {
    const fees: Fee[] = [{ name: "Tuition", amount: 5000, status: "published" }];
    const payments: Payment[] = [{ items: ["Tuition|5000"], status: null }];
    expect(computeBalance(fees, payments).items[0].status).toBe("paid");
  });

  it("a fully-unpaid student owes the sum of all published fees", () => {
    const fees: Fee[] = [
      { name: "Tuition", amount: 5000, status: "published" },
      { name: "Books", amount: 2000, status: "published" },
      { name: "Uniform", amount: 3500, status: "published" },
    ];
    expect(computeBalance(fees, []).totalOutstanding).toBe(10500);
  });
});
