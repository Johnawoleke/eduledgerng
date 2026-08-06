// Settling a payment, in one place.
//
// Three callers can settle the same payment — the gateway's webhook, the
// redirect-verify the dashboard fires, and (for Paystack) its separate webhook.
// The Paystack-only version duplicated this logic across two files and they had
// already drifted, so the underpayment guard had to be written twice. One copy.
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

/** Mark a previously-pending attempt as failed. Safe to call repeatedly. */
export const markFailed = async (
  admin: Admin,
  reference: string,
  source: string
): Promise<void> => {
  const { data: row } = await admin
    .from("payments")
    .select("id, status")
    .eq("reference", reference)
    .maybeSingle();
  if (row && row.status === "pending") {
    await admin.from("payments").update({ status: "failed" }).eq("id", row.id);
  }
  await admin.from("payment_events").insert({
    event_type: `${source}.failed`,
    payment_id: reference,
    status: "failed",
    payload: { reference, source },
  });
};

export const settlePayment = async (
  admin: Admin,
  { reference, amountPaidKobo, metadata, gateway, source }: SettleInput
): Promise<SettleResult> => {
  if (!reference) return { recorded: false, note: "no_reference" };

  const { data: existing } = await admin
    .from("payments")
    .select("id, status, amount, school_id, student_id")
    .eq("reference", reference)
    .maybeSingle();

  if (existing && existing.status === "success") {
    return { recorded: true, note: "already_processed" };
  }

  // Never credit fees for a charge that collected less than we asked for.
  // expected_total_kobo is set by create-payment; charges from before that
  // field existed have nothing to compare and are trusted as they were.
  const expected = Number(metadata.expected_total_kobo);
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
    method: gateway === "squad" ? "Squad" : "Paystack",
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
