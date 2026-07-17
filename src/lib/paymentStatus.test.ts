import { describe, it, expect } from "vitest";
import { isSettledPayment, nextPaymentStatus } from "./paymentStatus";

describe("isSettledPayment — only settled money counts", () => {
  it("counts success", () => {
    expect(isSettledPayment({ status: "success" })).toBe(true);
  });

  it("counts legacy rows with no status (null/undefined)", () => {
    expect(isSettledPayment({ status: null })).toBe(true);
    expect(isSettledPayment({})).toBe(true);
  });

  it("excludes pending and failed", () => {
    expect(isSettledPayment({ status: "pending" })).toBe(false);
    expect(isSettledPayment({ status: "failed" })).toBe(false);
  });

  it("a filter over a mixed set keeps only the settled rows", () => {
    const rows = [
      { status: "success", amount: 100 },
      { status: "pending", amount: 999 },
      { status: "failed", amount: 999 },
      { status: null, amount: 50 },
    ];
    const settled = rows.filter(isSettledPayment);
    expect(settled.map((r) => r.amount)).toEqual([100, 50]);
    // Pending/failed never contribute to a total.
    expect(settled.reduce((s, r) => s + r.amount, 0)).toBe(150);
  });
});

describe("nextPaymentStatus — pending -> success/failed state machine", () => {
  it("success from a fresh/absent row", () => {
    expect(nextPaymentStatus(undefined, "success")).toBe("success");
    expect(nextPaymentStatus(null, "success")).toBe("success");
  });

  it("success from pending flips to success", () => {
    expect(nextPaymentStatus("pending", "success")).toBe("success");
  });

  it("a later success wins even over a prior failed", () => {
    expect(nextPaymentStatus("failed", "success")).toBe("success");
  });

  it("success when already success is a no-op", () => {
    expect(nextPaymentStatus("success", "success")).toBeNull();
  });

  it("failed only flips a pending attempt", () => {
    expect(nextPaymentStatus("pending", "failed")).toBe("failed");
  });

  it("failed NEVER overwrites a success", () => {
    expect(nextPaymentStatus("success", "failed")).toBeNull();
  });

  it("failed on an absent/failed row is a no-op (don't resurrect/duplicate)", () => {
    expect(nextPaymentStatus(undefined, "failed")).toBeNull();
    expect(nextPaymentStatus("failed", "failed")).toBeNull();
  });
});
