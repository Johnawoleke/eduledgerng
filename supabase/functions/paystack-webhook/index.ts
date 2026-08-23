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
import { settlePayment, markFailed, FAILURE_REASONS } from "../_shared/recordPayment.ts";

// Paystack echoes the payer's card and network details back on every event. We
// have no use for them and no obligation to hold them, so they never reach the
// audit table. Keep the parts that make an event reconcilable.
const redactPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const clone = JSON.parse(JSON.stringify(payload ?? {}));
  for (const container of [clone?.data, clone?.payment]) {
    if (container && typeof container === "object") {
      delete container.authorization;
      delete container.customer;
      delete container.ip_address;
      delete container.log;
      delete container.fees_breakdown;
    }
  }
  return clone;
};

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

    // Audit log for every verified event (card/customer/IP branches stripped)
    await supabaseAdmin.from("payment_events").insert({
      event_type: event || null,
      payment_id: reference || String(data.id || "") || null,
      status: status || null,
      amount_usd: null,
      payload: redactPayload(payload as Record<string, unknown>),
    });

    const metadata = (data.metadata || {}) as Record<string, unknown>;

    // --- Everything below settles through _shared/recordPayment.ts -----------
    //
    // This function used to carry its OWN copy of the settle logic: the
    // underpayment guard, the item encoding, the pending->success flip and the
    // fresh-insert fallback, all duplicated from verify-payment. recordPayment
    // exists precisely because those two copies drifted once already and only
    // one of them was right. This one was never actually moved onto it, so the
    // drift was still there, and the guard here was the weaker of the two: it
    // read expected_total_kobo from the gateway's echoed METADATA only, where
    // the shared one prefers our own row. A provider changing the shape of that
    // echo would make it NaN and silently disable the amount check on the path
    // that matters most, since the webhook is what settles a bank transfer the
    // payer never comes back to the browser for.

    // A declined card or a cancelled attempt. No money moved, so the advice is
    // simply to try again — telling this payer a refund is coming would be
    // wrong, which is why the reason is per-cause and not one generic line.
    if (event === "charge.failed" || (event === "charge" && status === "failed")) {
      await markFailed(supabaseAdmin, reference, "webhook", FAILURE_REASONS.declined);
      return json({ received: true, marked: "failed", reference });
    }

    // A transfer of the wrong amount is REJECTED by Paystack and refunded to
    // the payer automatically, within 24 hours, so charge.success never fires
    // for it (support.paystack.com/en/articles/2128642). We used to fall
    // through and ignore the rejection: the attempt sat pending forever, the
    // balance did not move, and the payer, who had just sent money, was told
    // nothing. It is terminal and it has to say why.
    if (event.startsWith("bank.transfer.") && event !== "bank.transfer.success") {
      await markFailed(supabaseAdmin, reference, "webhook", FAILURE_REASONS.wrong_amount);
      return json({ received: true, marked: "failed", reason: "wrong_amount", reference });
    }

    if (event !== "charge.success" || status !== "success") {
      return json({ received: true, ignored: event || status || "unknown" });
    }

    const settled = await settlePayment(supabaseAdmin, {
      reference,
      amountPaidKobo: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
      metadata,
      gateway: "paystack",
      source: "webhook",
    });

    return json({ received: true, reference, ...settled });
  } catch (error) {
    console.error("Webhook error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
