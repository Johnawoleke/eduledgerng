// Deciding whether a payment attempt is over, imported straight from the Deno
// source so there is no second copy to drift.
//
// The asymmetry is the whole point: writing off an attempt that is still in
// flight marks a LIVE payment failed, so create-payment stops counting it and
// asks the student to pay a second time for money already collected. Leaving a
// dead attempt pending costs a stale row. Everything here must therefore be an
// allow-list, and anything unrecognised must read as still running.
import { describe, it, expect } from "vitest";
import {
  isTerminalFailure, isTransferRejection,
} from "../../supabase/functions/_shared/paymentOutcome";

describe("isTerminalFailure", () => {
  it("recognises the states that mean no money is coming", () => {
    for (const s of ["failed", "abandoned", "reversed", "cancelled", "declined", "expired", "rejected"]) {
      expect(isTerminalFailure(s)).toBe(true);
    }
  });

  it("leaves anything still in flight alone", () => {
    // A bank transfer routinely has not confirmed by the time the payer is
    // redirected back from checkout. Writing that off is the expensive mistake.
    for (const s of ["pending", "processing", "ongoing", "queued", "success", ""]) {
      expect(isTerminalFailure(s)).toBe(false);
    }
  });

  it("treats an unrecognised status as still running", () => {
    expect(isTerminalFailure("some_new_paystack_state")).toBe(false);
  });

  it("ignores case, which providers are inconsistent about", () => {
    expect(isTerminalFailure("FAILED")).toBe(true);
    expect(isTerminalFailure("Abandoned")).toBe(true);
  });
});

describe("isTransferRejection", () => {
  it("catches a rejected inbound transfer", () => {
    expect(isTransferRejection("bank.transfer.rejected")).toBe(true);
    expect(isTransferRejection("bank.transfer.failed")).toBe(true);
    expect(isTransferRejection("bank.transfer.reversed")).toBe(true);
  });

  it("does NOT fire on success", () => {
    expect(isTransferRejection("bank.transfer.success")).toBe(false);
  });

  it("does NOT fire on an intermediate event", () => {
    // This is the regression guard. The first version matched "any
    // bank.transfer event that is not success", so an init or a pending — both
    // perfectly plausible names we have never observed — would have marked a
    // live payment failed and asked the parent to pay again.
    for (const e of ["bank.transfer.init", "bank.transfer.pending", "bank.transfer.processing", "bank.transfer"]) {
      expect(isTransferRejection(e)).toBe(false);
    }
  });

  it("ignores events that are not inbound transfers at all", () => {
    // transfer.failed is an OUTGOING payout, nothing to do with a student's fee.
    expect(isTransferRejection("transfer.failed")).toBe(false);
    expect(isTransferRejection("charge.failed")).toBe(false);
    expect(isTransferRejection("")).toBe(false);
  });
});
