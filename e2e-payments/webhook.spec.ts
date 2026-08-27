import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  secretsPresent, loginStudent, createPending, readPayment, cleanup,
  signedWebhook, callFunction, chargeSuccessBody,
  type StudentSession, type Pending, type Json,
} from "./helpers";

// Every case here maps to something that has ALREADY been wrong in this
// codebase, and each of those failures was silent. Pure tests could not have
// caught any of them, because each one lives in the seam between our code and
// Paystack's payload.
const missing = secretsPresent();
const suite = missing ? describe.skip : describe;
if (missing) {
  console.warn(
    `\n  Skipping payment webhook suite: ${missing} is not set.\n` +
      `  These tests drive real staging functions and sign webhooks with the\n` +
      `  Paystack TEST key the staging function verifies against. See\n` +
      `  docs/PAYMENT_TEST_RUNBOOK.md.\n`
  );
}

suite("the payment webhook, against the deployed staging function", () => {
  let session: StudentSession;
  const created: string[] = [];

  const fresh = async (): Promise<Pending> => {
    const p = await createPending(session);
    created.push(p.reference);
    return p;
  };

  beforeAll(async () => { session = await loginStudent(); });
  // Whatever these tests credited has to come back off, or the ledger suite
  // starts asserting against balances this one moved.
  afterAll(async () => { await cleanup(created); });

  describe("the signature gate", () => {
    it("refuses a body with no signature at all", async () => {
      const p = await fresh();
      const res = await callFunction("paystack-webhook", chargeSuccessBody(p, p.totalKobo));
      expect(res.status).toBe(401);
      expect((await readPayment(p.reference))?.status).toBe("pending");
    });

    it("refuses a wrong signature, and changes nothing", async () => {
      const p = await fresh();
      const res = await callFunction(
        "paystack-webhook",
        chargeSuccessBody(p, p.totalKobo),
        { "x-paystack-signature": "deadbeef" }
      );
      expect(res.body?.error).toMatch(/signature/i);
      expect((await readPayment(p.reference))?.status).toBe("pending");
    });

    it("accepts a genuine HMAC-SHA512 over the RAW body", async () => {
      // The signature covers the exact bytes posted. This is the only test that
      // proves our verification agrees with Paystack's construction.
      const p = await fresh();
      const res = await signedWebhook(chargeSuccessBody(p, p.totalKobo));
      expect(res.status).toBe(200);
      expect(res.body?.error).toBeUndefined();
    });
  });

  describe("a payment for the exact amount", () => {
    it("settles, and credits exactly what was billed", async () => {
      const p = await fresh();
      await signedWebhook(chargeSuccessBody(p, p.totalKobo));

      const row = await readPayment(p.reference);
      expect(row?.status).toBe("success");
      expect(Number(row?.amount)).toBe(p.baseNGN);
      expect(row?.failure_reason).toBeFalsy();
      // The line item carries the fee id, so reconciliation matches by id and
      // cannot cross-credit two fees sharing a name.
      expect((row?.items || []).join("|")).toContain(p.feeId);
    });

    it("is idempotent — the webhook and the redirect-verify both firing credits once", async () => {
      const p = await fresh();
      await signedWebhook(chargeSuccessBody(p, p.totalKobo));
      const first = await readPayment(p.reference);

      await signedWebhook(chargeSuccessBody(p, p.totalKobo));
      const second = await readPayment(p.reference);

      expect(second?.status).toBe("success");
      expect(Number(second?.amount)).toBe(Number(first?.amount));
      expect(second?.items).toEqual(first?.items);
    });
  });

  describe("a payment for less than we asked", () => {
    it("credits NOTHING and says why", async () => {
      // The guard that stops a school being told a fee is settled when only
      // part of it arrived.
      const p = await fresh();
      const short = Math.floor(p.totalKobo * 0.8);
      await signedWebhook(chargeSuccessBody(p, short));

      const row = await readPayment(p.reference);
      expect(row?.status).not.toBe("success");
      expect(row?.failure_reason).toBeTruthy();
      expect(row?.failure_reason).toMatch(/did not match|exact amount/i);
    });

    it("credits nothing when the gateway reports no amount at all", async () => {
      // Number(undefined) is NaN and must never read as "paid in full".
      const p = await fresh();
      const body: Json = chargeSuccessBody(p, 0);
      delete body.data.amount;
      await signedWebhook(body);
      expect((await readPayment(p.reference))?.status).not.toBe("success");
    });
  });

  describe("a rejected bank transfer", () => {
    // Paystack rejects and auto-refunds a transfer for the wrong amount, so
    // charge.success never fires for one. What we owe the payer is a reason,
    // and the reference has to be found in whichever field the payload uses.

    it("is marked failed when the reference is top level", async () => {
      const p = await fresh();
      const res = await signedWebhook({
        event: "bank.transfer.rejected",
        data: { reference: p.reference, status: "failed", amount: 50000 },
      });
      expect(res.status).toBe(200);

      const row = await readPayment(p.reference);
      expect(row?.status).toBe("failed");
      expect(row?.failure_reason).toMatch(/not accepted|exact amount/i);
    });

    it("is marked failed when the reference is NESTED under bank_transfer", async () => {
      // The regression guard for the version that read only data.reference: it
      // matched no row, returned early, and did nothing while looking deployed.
      // Published integrations disagree about which field carries it.
      const p = await fresh();
      await signedWebhook({
        event: "bank.transfer.rejected",
        data: { bank_transfer: { transaction_id: p.reference, amount: "500" } },
      });

      const row = await readPayment(p.reference);
      expect(row?.status).toBe("failed");
      expect(row?.failure_reason).toBeTruthy();
    });

    it("passes Paystack's own wording through to the payer", async () => {
      // A rejection is not always a wrong amount; it also fires on a fraud
      // flag. The specific cause can only come from Paystack.
      const p = await fresh();
      await signedWebhook({
        event: "bank.transfer.rejected",
        data: {
          reference: p.reference,
          bank_transfer: { transaction_id: p.reference, message: "Amount mismatch" },
        },
      });
      expect((await readPayment(p.reference))?.failure_reason).toContain("Amount mismatch");
    });

    it("never marks a payment failed on a NON-terminal transfer event", async () => {
      // The bug this suite exists to prevent recurring. An earlier version
      // matched "any bank.transfer event that is not success", so an
      // intermediate event would write off a live payment and ask the parent to
      // pay twice for money already taken.
      const p = await fresh();
      for (const event of ["bank.transfer.pending", "bank.transfer.init"]) {
        await signedWebhook({ event, data: { reference: p.reference } });
        expect((await readPayment(p.reference))?.status).toBe("pending");
      }
    });
  });

  describe("events we do not act on", () => {
    it("acknowledges an unrelated event without touching the row", async () => {
      const p = await fresh();
      const res = await signedWebhook({
        event: "subscription.create",
        data: { reference: p.reference },
      });
      expect(res.status).toBe(200);
      expect((await readPayment(p.reference))?.status).toBe("pending");
    });

    it("does not write an event row for a reference we never issued", async () => {
      // paystack-webhook is unauthenticated by design, so anyone can POST a
      // junk reference; only a valid signature gets this far.
      const res = await signedWebhook({
        event: "bank.transfer.rejected",
        data: { reference: "NOT-A-REAL-REFERENCE-XYZ" },
      });
      expect(res.status).toBe(200);
      expect(await readPayment("NOT-A-REAL-REFERENCE-XYZ")).toBeNull();
    });
  });
});
