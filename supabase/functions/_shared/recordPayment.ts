// Settling a payment, in one place.
//
// Two callers can settle the same payment — paystack-webhook, and the
// redirect-verify the dashboard fires when Paystack sends the payer back. An
// earlier build duplicated this logic across those two files and they drifted,
// so the underpayment guard had to be written twice and only one copy was
// right. One copy.
//
// Recording is idempotent on payments.reference (unique index), so any two of
// these racing is harmless.
import { encodeFeeItem } from "./feeItems.ts";
import { notifyPaymentReceived } from "./notify.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface SettleInput {
  reference: string;
  /** What the gateway says was collected, in kobo. Null when unknown. */
  amountPaidKobo: number | null;
  /** Metadata echoed back by the gateway — written by create-payment. */
  metadata: Record<string, unknown>;
  /** Which gateway is reporting. */
  gateway: string;
  /** Where this came from, for the audit log. */
  source: string;
}

export interface SettleResult {
  recorded: boolean;
  note: string;
}

/**
 * Why an attempt did not complete, in words a parent can act on.
 *
 * Per-reason rather than one generic line, because the right advice differs:
 * "Paystack is refunding you" is true for a transfer of the wrong amount and
 * actively wrong for a declined card, where no money ever left the account.
 */
export const FAILURE_REASONS = {
  wrong_amount:
    "The amount sent did not match the amount requested, so the payment was " +
    "cancelled. Paystack refunds a wrong amount automatically, usually within " +
    "24 hours. Please try again and send the exact amount shown at checkout.",
  declined:
    "The payment did not go through. No money has left your account. Please " +
    "try again, or use a different payment method.",
} as const;

/** Mark a previously-pending attempt as failed. Safe to call repeatedly. */
export const markFailed = async (
  admin: Admin,
  reference: string,
  source: string,
  reason: string = FAILURE_REASONS.declined
): Promise<void> => {
  const { data: row } = await admin
    .from("payments")
    .select("id, status")
    .eq("reference", reference)
    .maybeSingle();

  // Only log against a reference we actually issued. verify-payment takes an
  // unauthenticated reference, so writing an event unconditionally let anyone
  // append to the audit table at will just by POSTing junk references.
  if (!row) return;

  if (row.status === "pending") {
    await admin
      .from("payments")
      .update({ status: "failed", failure_reason: reason })
      .eq("id", row.id);
  }
  await admin.from("payment_events").insert({
    event_type: `${source}.failed`,
    payment_id: reference,
    status: "failed",
    payload: { reference, source, reason },
  });
};

export const settlePayment = async (
  admin: Admin,
  { reference, amountPaidKobo, metadata, gateway, source }: SettleInput
): Promise<SettleResult> => {
  if (!reference) return { recorded: false, note: "no_reference" };

  const { data: existing } = await admin
    .from("payments")
    .select("id, status, amount, school_id, student_id, expected_total_kobo")
    .eq("reference", reference)
    .maybeSingle();

  if (existing && existing.status === "success") {
    return { recorded: true, note: "already_processed" };
  }

  // Never credit fees for a charge that collected less than we asked for.
  //
  // Prefer the figure OUR row recorded at checkout over the one the gateway
  // echoes back. Relying on the echo means that if a provider returns metadata
  // under a key we did not anticipate, Number(undefined) is NaN, this guard is
  // skipped, and the pending row is flipped to success crediting the full fees
  // unchecked. Paystack's shape is well documented and stable, but the guard
  // should not depend on that — a provider changing its echo must not be able
  // to silently disable an amount check.
  //
  // A row with no stored value predates the column and is trusted as before.
  const expected = Number(existing?.expected_total_kobo ?? metadata.expected_total_kobo);
  if (Number.isFinite(expected) && expected > 0) {
    if (!Number.isFinite(Number(amountPaidKobo)) || Number(amountPaidKobo) < expected) {
      console.error(
        `Underpaid charge rejected: ${reference} paid ${amountPaidKobo} of ${expected} kobo`
      );
      await admin.from("payment_events").insert({
        event_type: `${source}.underpaid`,
        payment_id: reference,
        status: "underpaid",
        payload: { reference, gateway, expected_kobo: expected, paid_kobo: amountPaidKobo },
      });
      // Terminal, and it has to SAY so. Left pending, the payer sees a stuck
      // attempt, no movement on their balance and no explanation, having just
      // sent money — so they send it again.
      await markFailed(admin, reference, source, FAILURE_REASONS.wrong_amount);
      return { recorded: false, note: "amount_mismatch" };
    }
  }

  const items = metadata.items as
    | { fee_item_id?: string; name: string; amount: number }[]
    | undefined;

  let totalBase = 0;
  const encoded: string[] = [];
  for (const item of items || []) {
    const amt = Math.max(Number(item.amount), 0);
    if (amt <= 0) continue;
    totalBase += amt;
    encoded.push(encodeFeeItem(item.fee_item_id, item.name, amt));
  }

  // Flip the pending row we wrote at checkout.
  if (existing) {
    const patch: Record<string, unknown> = { status: "success" };
    if (totalBase > 0) {
      patch.amount = totalBase;
      patch.amount_paid = totalBase;
      patch.items = encoded;
    }
    const { error } = await admin.from("payments").update(patch).eq("id", existing.id);
    if (error) {
      console.error("settlePayment update failed:", error.message);
      return { recorded: false, note: error.message };
    }
    await admin.from("payment_events").insert({
      event_type: `${source}.recorded`,
      payment_id: reference,
      status: "success",
      payload: { reference, gateway, source, flipped: "pending->success" },
    });
    await notifyPaymentReceived(admin, {
      schoolId: (existing.school_id as string) || (metadata.school_id as string),
      reference,
      amountNGN: totalBase > 0 ? totalBase : Number(existing.amount) || 0,
      studentDbId: (existing.student_id as string) || (metadata.student_db_id as string),
    });
    return { recorded: true, note: "flipped" };
  }

  // No pending row — insert fresh. Needs the metadata we set at checkout.
  if (!metadata.school_id || !metadata.student_db_id || !items) {
    console.warn(`${reference}: success with no usable metadata`);
    return { recorded: false, note: "no_metadata" };
  }
  if (totalBase <= 0) return { recorded: false, note: "no_valid_payments" };

  const row: Record<string, unknown> = {
    school_id: metadata.school_id,
    student_id: metadata.student_db_id,
    amount: totalBase,
    amount_paid: totalBase,
    reference,
    method: "Paystack",
    gateway,
    status: "success",
    items: encoded,
  };
  if (metadata.session_id) row.session_id = metadata.session_id;
  if (metadata.term_id) row.term_id = metadata.term_id;

  const { error } = await admin.from("payments").insert(row);
  if (error) {
    // A concurrent webhook can race us; the unique index makes that harmless.
    console.error("settlePayment insert failed:", error.message);
    return { recorded: false, note: error.message };
  }

  await admin.from("payment_events").insert({
    event_type: `${source}.recorded`,
    payment_id: reference,
    status: "success",
    payload: { reference, gateway, source },
  });
  await notifyPaymentReceived(admin, {
    schoolId: metadata.school_id as string,
    reference,
    amountNGN: totalBase,
    studentDbId: metadata.student_db_id as string,
  });
  return { recorded: true, note: "inserted" };
};
