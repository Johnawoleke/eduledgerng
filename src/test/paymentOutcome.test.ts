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
  isTerminalFailure, isTransferRejection, referenceFromWebhook, rejectionMessageFrom,
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

describe("referenceFromWebhook", () => {
  it("reads the top-level reference a charge.success carries", () => {
    expect(referenceFromWebhook({ reference: "PSK-ABC-123" })).toBe("PSK-ABC-123");
  });

  it("falls back to the nested one a rejected transfer may carry instead", () => {
    // The regression this exists for: the first version read only
    // data.reference, so on bank.transfer.rejected it got "", matched no row,
    // and did nothing at all while looking perfectly deployed. Published
    // integrations disagree about the shape and Paystack's docs refuse
    // automated fetches, so both are read.
    expect(referenceFromWebhook({ bank_transfer: { transaction_id: "PSK-XYZ-9" } }))
      .toBe("PSK-XYZ-9");
    expect(referenceFromWebhook({ bank_transfer: { reference: "PSK-Q-1" } })).toBe("PSK-Q-1");
  });

  it("prefers the top-level one when both are present", () => {
    expect(referenceFromWebhook({
      reference: "TOP", bank_transfer: { transaction_id: "NESTED" },
    })).toBe("TOP");
  });

  it("copes with a numeric transaction id", () => {
    expect(referenceFromWebhook({ bank_transfer: { transaction_id: 12345 } })).toBe("12345");
  });

  it("returns empty rather than guessing when there is nothing to read", () => {
    // Empty is safe: markFailed matches no row and returns, and the event is
    // still in payment_events for someone to look at.
    expect(referenceFromWebhook({})).toBe("");
    expect(referenceFromWebhook({ reference: "" })).toBe("");
    expect(referenceFromWebhook({ bank_transfer: {} })).toBe("");
  });
});

describe("rejectionMessageFrom", () => {
  it("passes through Paystack's own words when given", () => {
    // A rejection is not always a wrong amount — it also fires for transfers
    // the fraud system flags — so the specific cause has to come from Paystack.
    expect(rejectionMessageFrom({ bank_transfer: { message: "Amount mismatch" } }))
      .toBe("Amount mismatch");
  });

  it("returns null when there is nothing worth showing", () => {
    expect(rejectionMessageFrom({})).toBeNull();
    expect(rejectionMessageFrom({ bank_transfer: { message: "   " } })).toBeNull();
  });
});
