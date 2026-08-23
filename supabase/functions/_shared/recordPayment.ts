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
import { encodeFeeItem, apportionPaidItems } from "./feeItems.ts";
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

  // Only log against a reference we actually issued. verify-payment takes an
  // unauthenticated reference, so writing an event unconditionally let anyone
  // append to the audit table at will just by POSTing junk references.
  if (!row) return;

  if (row.status === "pending") {
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
    .select("id, status, amount, school_id, student_id, expected_total_kobo")
    .eq("reference", reference)
    .maybeSingle();

  if (existing && existing.status === "success") {
    return { recorded: true, note: "already_processed" };
  }

  // Never credit more fees than the money that actually arrived.
  //
  // Prefer the figure OUR row recorded at checkout over the one the gateway
  // echoes back. Relying on the echo means that if a provider returns metadata
  // under a key we did not anticipate, Number(undefined) is NaN, the check is
  // skipped, and the pending row is flipped to success crediting the full fees
  // unchecked. Paystack's shape is well documented and stable, but this must
  // not depend on that — a provider changing its echo must never be able to
  // silently disable an amount check.
  //
  // A row with no stored value predates the column and is trusted as before.
  const expected = Number(existing?.expected_total_kobo ?? metadata.expected_total_kobo);
  const paid = Number(amountPaidKobo);
  let shortfall = false;

  if (Number.isFinite(expected) && expected > 0) {
    // If the gateway will not say how much it collected, we cannot credit
    // anything safely. Crediting the billed amount here is precisely the
    // over-credit this check exists to prevent.
    if (!Number.isFinite(paid)) {
      console.error(`${reference}: settled with no amount reported; not crediting`);
      await admin.from("payment_events").insert({
        event_type: `${source}.amount_unknown`,
        payment_id: reference,
        status: "amount_unknown",
        payload: { reference, gateway, expected_kobo: expected },
      });
      return { recorded: false, note: "amount_unknown" };
    }
    shortfall = paid < expected;
  }

  // A short payment used to be REFUSED outright: the money was collected and
  // settled to the school, while the student's dashboard still showed the full
  // amount owed and nothing anywhere explained the gap. Money held, no credit
  // given. Now the amount that arrived is credited across the fees it was meant
  // for, and only the remainder stays owing. Nobody is charged anything and
  // nothing is held unaccounted for.
  const items = metadata.items as
    | { fee_item_id?: string; name: string; amount: number }[]
    | undefined;

  const credited = apportionPaidItems(items, paid, expected);

  let totalBase = 0;
  const encoded: string[] = [];
  for (const item of credited) {
    totalBase += item.amount;
    encoded.push(encodeFeeItem(item.fee_item_id, item.name, item.amount));
  }

  // Flipping the row to success while totalBase is 0 leaves its ORIGINAL billed
  // amount in place — crediting the full fees for a part payment, which is the
  // exact over-credit this whole path exists to prevent.
  if (shortfall && totalBase <= 0) {
    console.error(`${reference}: short payment with nothing creditable; leaving pending`);
    await admin.from("payment_events").insert({
      event_type: `${source}.nothing_creditable`,
      payment_id: reference,
      status: "short_paid",
      payload: { reference, gateway, expected_kobo: expected, paid_kobo: paid },
    });
    return { recorded: false, note: "nothing_creditable" };
  }

  if (shortfall) {
    console.warn(
      `Short payment credited: ${reference} paid ${paid} of ${expected} kobo -> credited ${totalBase}`
    );
    await admin.from("payment_events").insert({
      event_type: `${source}.short_paid`,
      payment_id: reference,
      status: "short_paid",
      payload: {
        reference, gateway,
        expected_kobo: expected, paid_kobo: paid,
        credited_base: totalBase,
      },
    });
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
