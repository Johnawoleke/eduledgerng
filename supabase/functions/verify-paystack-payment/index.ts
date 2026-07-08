// verify-paystack-payment
//
// Called by the student dashboard when Paystack redirects back with a
// reference. Confirms the transaction server-side (GET /transaction/verify)
// and records the payment if the webhook hasn't landed yet — recording is
// idempotent on reference, so webhook + verify can both run safely.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { reference } = await req.json();
    if (!reference || typeof reference !== "string" || reference.length > 100) {
      return json({ error: "Missing reference" }, 400);
    }

    const paystackKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackKey) return json({ error: "Payment provider not configured" }, 500);

    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${paystackKey}` } }
    );
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || !verifyData?.data) {
      return json({ success: false, status: "not_found" }, 404);
    }

    const data = verifyData.data;
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Look up the row we recorded as 'pending' at creation time (may be absent
    // if the pending insert was skipped/raced).
    const { data: existingPayment } = await supabaseAdmin
      .from("payments")
      .select("id, status")
      .eq("reference", reference)
      .maybeSingle();

    // --- Not a success: mark the attempt failed (for admin visibility) --------
    if (data.status !== "success") {
      if (existingPayment) {
        if (existingPayment.status === "pending") {
          await supabaseAdmin
            .from("payments")
            .update({ status: "failed" })
            .eq("id", existingPayment.id);
        }
      }
      await supabaseAdmin.from("payment_events").insert({
        event_type: "verify.failed",
        payment_id: reference,
        status: data.status || "failed",
        payload: { reference, source: "verify-paystack-payment", status: data.status },
      });
      return json({ success: false, status: data.status || "pending" });
    }

    // --- Success ------------------------------------------------------------
    const metadata = data.metadata || {};
    const items = metadata.items as { name: string; amount: number }[] | undefined;

    let totalBaseAmount = 0;
    const itemNames: string[] = [];
    for (const item of items || []) {
      const payAmount = Math.max(Number(item.amount), 0);
      if (payAmount <= 0) continue;
      totalBaseAmount += payAmount;
      itemNames.push(`${item.name}|${payAmount}`);
    }

    // Already recorded as success (webhook beat us) — nothing to do.
    if (existingPayment && existingPayment.status === "success") {
      return json({ success: true, recorded: true, already_processed: true });
    }

    // Pending row exists -> flip it to success (reconciling amount/items from
    // the authoritative verify response).
    if (existingPayment) {
      const patch: Record<string, unknown> = { status: "success" };
      if (totalBaseAmount > 0) {
        patch.amount = totalBaseAmount;
        patch.amount_paid = totalBaseAmount;
        patch.items = itemNames;
      }
      const { error: updErr } = await supabaseAdmin
        .from("payments")
        .update(patch)
        .eq("id", existingPayment.id);
      if (updErr) {
        console.error("verify-paystack-payment update:", updErr.message);
        return json({ success: true, recorded: false, note: updErr.message });
      }
      await supabaseAdmin.from("payment_events").insert({
        event_type: "verify.recorded",
        payment_id: reference,
        status: "success",
        payload: { reference, source: "verify-paystack-payment", flipped: "pending->success" },
      });
      return json({ success: true, recorded: true, amount: totalBaseAmount });
    }

    // No pending row -> insert a fresh success row (needs metadata).
    if (!metadata.school_id || !metadata.student_db_id || !items) {
      return json({ success: true, recorded: false, note: "no_metadata" });
    }
    if (totalBaseAmount <= 0) return json({ success: true, recorded: false, note: "no_valid_payments" });

    const paymentRecord: Record<string, unknown> = {
      school_id: metadata.school_id,
      student_id: metadata.student_db_id,
      amount: totalBaseAmount,
      amount_paid: totalBaseAmount,
      reference,
      method: "Paystack",
      status: "success",
      items: itemNames,
    };
    if (metadata.session_id) paymentRecord.session_id = metadata.session_id;
    if (metadata.term_id) paymentRecord.term_id = metadata.term_id;

    const { error: payError } = await supabaseAdmin.from("payments").insert(paymentRecord);
    if (payError) {
      // A concurrent webhook insert can race us here; the unique index on
      // reference makes that harmless.
      console.error("verify-paystack-payment insert:", payError.message);
      return json({ success: true, recorded: false, note: payError.message });
    }

    await supabaseAdmin.from("payment_events").insert({
      event_type: "verify.recorded",
      payment_id: reference,
      status: "success",
      payload: { reference, source: "verify-paystack-payment" },
    });

    return json({ success: true, recorded: true, amount: totalBaseAmount });
  } catch (error) {
    console.error("Error in verify-paystack-payment:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
