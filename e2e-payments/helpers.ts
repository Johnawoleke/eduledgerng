// Driving the real staging payment path, end to end.
//
// WHAT THIS SUITE IS FOR. Everything about settling a payment has, until now,
// been verified only as pure logic. The parts that actually decide whether a
// school gets paid are the parts pure tests cannot reach: does the HMAC check
// accept a genuine Paystack signature, does the event router pick the right
// branch, is the reference read from the place the payload really puts it, and
// does the database end up in the right state. Every one of those has already
// been wrong at least once, and each failure was silent.
//
// So these tests create a REAL pending payment through create-payment on
// staging, sign a webhook with the same key the deployed function verifies
// against, POST it to the deployed function, and then read the row back.
//
// WHAT IT STILL CANNOT DO. It cannot make a bank transfer of the wrong amount.
// That needs a person with a bank app; Paystack's checkout account is scoped to
// one amount by design. So the PAYLOADS here are synthetic — correctly signed,
// but written by us. If Paystack's real bank.transfer.rejected body differs from
// what published integrations describe, this suite passes and production still
// does nothing. docs/PAYMENT_TEST_RUNBOOK.md covers that half by hand.
//
// It writes to staging and deletes what it writes. Anything it leaves behind
// changes a balance the e2e-staging ledger suite asserts on.
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

/**
 * A parsed JSON response. Deliberately loose: these tests assert against real
 * gateway and edge-function payloads, and pinning a shape here would only
 * duplicate the very contracts the suite exists to check.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

const parseJson = (text: string): Json => {
  try { return JSON.parse(text); } catch { return text; }
};

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. This suite talks to staging and Paystack test mode; ` +
        `put the value in .env.local (git-ignored) and re-run.`
    );
  }
  return v;
};

/** Present and complete enough to run? Used to skip with a clear reason. */
export const secretsPresent = (): string | null => {
  for (const k of ["STAGING_SERVICE_ROLE_KEY", "PAYSTACK_TEST_SECRET_KEY"]) {
    if (!process.env[k]) return k;
  }
  return null;
};

export const STAGING_URL =
  process.env.STAGING_SUPABASE_URL || "https://vmqeqwszeekzkvtxkebv.supabase.co";

/** Staging test accounts, documented in CLAUDE.md. */
export const STUDENT = { id: "OCD-1234", password: "Staging123!" };
export const SCHOOL_SLUG = "demo";

export const admin = () =>
  createClient(STAGING_URL, need("STAGING_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

/** Call a deployed edge function the way the app does. */
export const callFunction = async (
  name: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${STAGING_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: parseJson(text) };
};

/**
 * Sign a webhook body the way Paystack does: HMAC-SHA512 of the RAW body with
 * the secret key, hex encoded, in x-paystack-signature.
 *
 * The signature is over the exact bytes sent, so the body must be serialised
 * once and that same string both signed and posted. Signing an object and
 * posting a re-serialised copy is a classic way to get a suite that passes
 * against a function that would reject the real thing.
 */
export const signedWebhook = async (payload: unknown) => {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha512", need("PAYSTACK_TEST_SECRET_KEY"))
    .update(raw)
    .digest("hex");
  const res = await fetch(`${STAGING_URL}/functions/v1/paystack-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": signature },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, body: parseJson(text) };
};

export interface StudentSession {
  token: string;
  studentDbId: string;
  fees: { id: string; name: string; amount: number; paid: number }[];
}

/** Log the staging student in and read their payable fees. */
export const loginStudent = async (): Promise<StudentSession> => {
  const { status, body } = await callFunction("student-auth", {
    student_id: STUDENT.id,
    pin: STUDENT.password,
    school_slug: SCHOOL_SLUG,
  });
  if (status !== 200 || !body?.session_token) {
    throw new Error(`student-auth failed (${status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  // feeItems is the SELECTED period; owing spans every period. Either is
  // payable — create-payment takes the period from the charge — so take
  // whichever actually has something outstanding.
  const raw = [...(body.feeItems || []), ...(body.owing || []), ...(body.arrears || [])];
  const seen = new Set<string>();
  const fees = raw
    .filter((f: Json) => f?.id && !seen.has(f.id) && seen.add(f.id))
    .map((f: Json) => ({
      id: f.id, name: f.name, amount: Number(f.amount), paid: Number(f.paid || 0),
    }));
  return { token: body.session_token, studentDbId: body.student?.id, fees };
};

export interface Pending {
  reference: string;
  totalKobo: number;
  baseNGN: number;
  feeId: string;
  feeName: string;
}

/**
 * Create a genuine pending payment, exactly as the student dashboard does.
 *
 * Deliberately NOT inserted directly: expected_total_kobo, the item encoding
 * and the period stamping are all decided by create-payment, and a test that
 * writes its own row would prove nothing about the code that writes the real
 * one.
 */
export const createPending = async (
  session: StudentSession,
  payNGN?: number
): Promise<Pending> => {
  const fee = session.fees.find((f) => f.amount - f.paid > 0);
  if (!fee) throw new Error("The staging student owes nothing; nothing to pay.");
  const amount = payNGN ?? Math.min(100, fee.amount - fee.paid);

  const { status, body } = await callFunction("create-payment", {
    school_slug: SCHOOL_SLUG,
    session_token: session.token,
    fee_payments: [{ fee_item_id: fee.id, amount }],
  });
  if (status !== 200 || !body?.reference) {
    throw new Error(`create-payment failed (${status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  return {
    reference: body.reference,
    totalKobo: Math.round(Number(body.total_ngn) * 100),
    baseNGN: Number(body.base_amount),
    feeId: fee.id,
    feeName: fee.name,
  };
};

export const readPayment = async (reference: string) => {
  const { data } = await admin()
    .from("payments")
    .select("id, status, amount, amount_paid, items, failure_reason, expected_total_kobo")
    .eq("reference", reference)
    .maybeSingle();
  return data;
};

/** Remove everything a test created, so balances stay where the ledger suite expects. */
export const cleanup = async (references: string[]) => {
  if (references.length === 0) return;
  const a = admin();
  await a.from("payment_events").delete().in("payment_id", references);
  await a.from("payments").delete().in("reference", references);
};

/** A Paystack charge.success body, shaped the way Paystack sends it. */
export const chargeSuccessBody = (p: Pending, amountKobo: number, metadata: unknown = {}) => ({
  event: "charge.success",
  data: {
    id: 1234567890,
    reference: p.reference,
    status: "success",
    amount: amountKobo,
    currency: "NGN",
    channel: "bank_transfer",
    paid_at: new Date().toISOString(),
    metadata,
  },
});
