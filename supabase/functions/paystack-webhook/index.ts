// paystack-webhook
//
// Receives Paystack events, verifies the x-paystack-signature header
// (HMAC-SHA512 of the raw body with the secret key), and on charge.success
// records the payment idempotently (unique on reference).
//
// Point Paystack's webhook URL at:
//   https://<project-ref>.supabase.co/functions/v1/paystack-webhook
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-paystack-signature",
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmacSha512Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
    const bodyText = await req.text();
    if (!bodyText) return json({ received: true, ignored: "empty body" });

    const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!secret) {
      console.error("PAYSTACK_SECRET_KEY not set - rejecting webhook");
      return json({ error: "not configured" }, 401);
    }

    const signature = req.headers.get("x-paystack-signature") || "";
    const expected = await hmacSha512Hex(secret, bodyText);
    if (!signature || !constantTimeEqual(expected, signature.trim())) {
      console.warn("Paystack webhook rejected: signature mismatch");
      return json({ error: "Invalid signature" }, 401);
    }

    let payload: { event?: string; data?: Record<string, unknown> };
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const event = payload.event || "";
    const data = (payload.data || {}) as Record<string, unknown>;
    const status = String(data.status || "");
    const reference = String(data.reference || "");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Audit log for every verified event
    await supabaseAdmin.from("payment_events").insert({
      event_type: event || null,
      payment_id: reference || String(data.id || "") || null,
      status: status || null,
      amount_usd: null,
      payload,
    });

    const metadata = (data.metadata || {}) as Record<string, unknown>;

    // The row recorded as 'pending' at creation time (may be absent).
    const { data: existingPayment } = reference
      ? await supabaseAdmin
          .from("payments")
          .select("id, status")
          .eq("reference", reference)
          .maybeSingle()
      : { data: null };

    // --- Failed charge: mark the attempt failed (for admin visibility) --------
    if (event === "charge.failed" || (event === "charge" && status === "failed")) {
      if (existingPayment && existingPayment.status === "pending") {
        await supabaseAdmin
          .from("payments")
          .update({ status: "failed" })
          .eq("id", existingPayment.id);
      }
      return json({ received: true, marked: "failed", reference });
    }

    if (event !== "charge.success" || status !== "success") {
      return json({ received: true, ignored: event || status || "unknown" });
    }

    const items = metadata.items as { name: string; amount: number }[] | undefined;

    // Already recorded as success (verify beat us) — nothing to do.
    if (existingPayment && existingPayment.status === "success") {
      return json({ received: true, already_processed: true });
    }

    let totalBaseAmount = 0;
    const itemNames: string[] = [];
    for (const item of items || []) {
      const payAmount = Math.max(Number(item.amount), 0);
      if (payAmount <= 0) continue;
      totalBaseAmount += payAmount;
      itemNames.push(`${item.name}|${payAmount}`);
    }

    // Pending row exists -> flip it to success.
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
        console.error("Failed to flip payment to success:", updErr);
        return json({ error: "Failed to record payment" }, 500);
      }
      console.log("Paystack payment flipped to success:", reference);
      return json({ received: true, reference, flipped: true });
    }

    // No pending row -> insert a fresh success row (needs metadata).
    if (!reference || !metadata.school_id || !metadata.student_db_id || !items) {
      console.warn("charge.success missing required metadata:", JSON.stringify(metadata));
      return json({ received: true, note: "no_metadata" });
    }
    if (totalBaseAmount <= 0) return json({ received: true, note: "no_valid_payments" });

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
      console.error("Failed to insert payment:", payError);
      return json({ error: "Failed to record payment" }, 500);
    }

    console.log("Paystack payment recorded:", reference, "Amount:", totalBaseAmount);
    return json({ received: true, reference, amount: totalBaseAmount });
  } catch (error) {
    console.error("Webhook error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
