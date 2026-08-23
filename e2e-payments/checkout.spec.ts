import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  secretsPresent, loginStudent, createPending, cleanup, callFunction,
  SCHOOL_SLUG, type StudentSession,
} from "./helpers";

// The other half of the seam: does create-payment actually reach Paystack and
// get a real checkout back, with the amounts we intended?
//
// The money maths is unit-tested to death in gatewayMoney.test.ts. What is NOT
// covered there is whether the live call succeeds at all — a wrong bank code, a
// missing settlement account or an unprovisioned subaccount all fail here and
// nowhere else. That is exactly how "invalid subaccount" reached production.
const missing = secretsPresent();
const suite = missing ? describe.skip : describe;

suite("create-payment against the real Paystack test API", () => {
  let session: StudentSession;
  const created: string[] = [];

  beforeAll(async () => { session = await loginStudent(); });
  afterAll(async () => { await cleanup(created); });

  it("returns a real Paystack checkout URL", async () => {
    const p = await createPending(session);
    created.push(p.reference);
    // Proves the school's subaccount resolved and Paystack accepted the
    // initialize. A cached subaccount from a different key fails right here.
    const { body } = await callFunction("create-payment", {
      school_slug: SCHOOL_SLUG,
      session_token: session.token,
      fee_payments: [{ fee_item_id: p.feeId, amount: 100 }],
    });
    created.push(body.reference);
    expect(body.authorization_url).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    expect(body.gateway).toBe("paystack");
  });

  it("charges the parent MORE than the school receives, never less", async () => {
    // The school must receive the exact fee it set; the platform's 1% and
    // Paystack's charge are added on top. If this ever inverts, every school is
    // short on every payment.
    const p = await createPending(session);
    created.push(p.reference);
    expect(p.totalKobo).toBeGreaterThan(p.baseNGN * 100);
  });

  it("refuses a fee the student was never charged", async () => {
    // The charge IS the authorisation to pay. A fee id the student has no
    // charge for must not become payable by asking for it.
    const { status, body } = await callFunction("create-payment", {
      school_slug: SCHOOL_SLUG,
      session_token: session.token,
      fee_payments: [{ fee_item_id: "00000000-0000-0000-0000-000000000000", amount: 5000 }],
    });
    expect(status).not.toBe(200);
    expect(JSON.stringify(body)).toMatch(/no valid payments/i);
  });

  it("clamps an inflated amount to what is actually owed", async () => {
    // The browser's number is a REQUEST. create-payment recomputes from
    // student_charges and takes the lower of the two, so a tampered client can
    // only ever be charged more, never credited more.
    const fee = session.fees.find((f) => f.amount - f.paid > 0)!;
    const owed = fee.amount - fee.paid;
    const { body } = await callFunction("create-payment", {
      school_slug: SCHOOL_SLUG,
      session_token: session.token,
      fee_payments: [{ fee_item_id: fee.id, amount: owed + 999_999 }],
    });
    created.push(body.reference);
    expect(Number(body.base_amount)).toBe(owed);
  });

  it("rejects a bad session token", async () => {
    const { status } = await callFunction("create-payment", {
      school_slug: SCHOOL_SLUG,
      session_token: "not-a-real-token",
      fee_payments: [{ fee_item_id: session.fees[0]?.id, amount: 100 }],
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });
});
