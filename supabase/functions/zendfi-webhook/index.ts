import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function verifySignature(body: string, signatureHeader: string | null): Promise<{ valid: boolean; reason: string }> {
  const secret = Deno.env.get("ZENDFI_WEBHOOK_SECRET");

  if (!secret) {
    console.warn("ZENDFI_WEBHOOK_SECRET not set - skipping verification");
    return { valid: true, reason: "no_secret_configured" };
  }

  if (!signatureHeader) {
    console.warn("No X-Zendfi-Signature header present - rejecting");
    return { valid: false, reason: "missing_signature" };
  }

  // Parse t=timestamp,v1=signature format
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      parts[part.substring(0, eqIdx).trim()] = part.substring(eqIdx + 1).trim();
    }
  }

  const timestamp = parts["t"];
  const signature = parts["v1"];

  if (!timestamp || !signature) {
    return { valid: false, reason: "malformed_signature_header" };
  }

  const signedPayload = `${timestamp}.${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const expectedSignature = new TextDecoder().decode(hexEncode(new Uint8Array(signatureBuffer)));

  if (expectedSignature.length !== signature.length) {
    return { valid: false, reason: "signature_mismatch" };
  }

  let mismatch = 0;
  for (let i = 0; i < expectedSignature.length; i++) {
    mismatch |= expectedSignature.charCodeAt(i) ^ signature.charCodeAt(i);
  }

  return mismatch === 0
    ? { valid: true, reason: "signature_verified" }
    : { valid: false, reason: "signature_mismatch" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const signatureHeader = req.headers.get("x-zendfi-signature");
    const bodyText = await req.text();

    if (!bodyText || bodyText.trim().length === 0) {
      return new Response(JSON.stringify({ received: true, ignored: "empty body" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const verification = await verifySignature(bodyText, signatureHeader);
    console.log("Signature verification:", verification.reason);
    if (!verification.valid) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let payload: any;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Zendfi webhook parsed:", JSON.stringify(payload));

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Zendfi payload shape (per docs):
    //   { event: "PaymentConfirmed", payment: { id, status, amount_usd, metadata, ... }, ... }
    // Older/alternate shapes may nest under data.payment — we check both just in case.
    const eventName: string | undefined = payload?.event;
    const paymentObj = payload?.payment || payload?.data?.payment;
    const paymentStatus: string | undefined = paymentObj?.status;

    // Insert into payment_events for realtime tracking
    await supabaseAdmin.from("payment_events").insert({
      event_type: eventName || null,
      payment_id: paymentObj?.id || null,
      status: paymentStatus || null,
      amount_usd: paymentObj?.amount_usd || null,
      payload: payload,
    });

    // --- Payment processing logic ---
    // Zendfi's success signal is event="PaymentConfirmed" with payment.status="confirmed".
    // We also accept a few related success events and a couple of legacy/alternate status strings
    // so the handler is resilient to minor payload changes.
    const isSuccessEvent =
      eventName === "PaymentConfirmed" ||
      eventName === "PaymentIntentSucceeded" ||
      eventName === "InvoicePaid" ||
      paymentStatus === "confirmed" ||
      paymentStatus === "succeeded" ||
      paymentStatus === "successful" ||
      paymentStatus === "completed";

    if (!isSuccessEvent) {
      console.log("Ignoring non-success webhook:", eventName, paymentStatus);
      return new Response(
        JSON.stringify({ received: true, ignored: eventName || paymentStatus || "unknown" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Metadata is echoed back nested under payment (per Zendfi docs). Fall back to older paths.
    const metadata =
      paymentObj?.metadata ||
      payload?.metadata ||
      payload?.data?.metadata;

    if (!metadata?.reference || !metadata?.school_id || !metadata?.student_db_id || !metadata?.items) {
      console.warn("Webhook success event missing required metadata:", metadata);
      return new Response(JSON.stringify({ received: true, note: "no_metadata" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotency check
    const { data: existingPayment } = await supabaseAdmin
      .from("payments")
      .select("id")
      .eq("reference", metadata.reference)
      .maybeSingle();

    if (existingPayment) {
      return new Response(JSON.stringify({ received: true, already_processed: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let totalBaseAmount = 0;
    const itemNames: string[] = [];

    for (const item of metadata.items) {
      const payAmount = Math.max(Number(item.amount), 0);
      if (payAmount <= 0) continue;
      totalBaseAmount += payAmount;
      itemNames.push(`${item.name}|${payAmount}`);
    }

    if (totalBaseAmount <= 0) {
      return new Response(JSON.stringify({ received: true, note: "no_valid_payments" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Record payment with session_id and term_id
    const paymentRecord: any = {
      school_id: metadata.school_id,
      student_id: metadata.student_db_id,
      amount: totalBaseAmount,
      reference: metadata.reference,
      method: "Bank Transfer (Zendfi)",
      items: itemNames,
    };

    if (metadata.session_id) paymentRecord.session_id = metadata.session_id;
    if (metadata.term_id) paymentRecord.term_id = metadata.term_id;

    const { error: payError } = await supabaseAdmin
      .from("payments")
      .insert(paymentRecord);

    if (payError) {
      console.error("Failed to insert payment:", payError);
      return new Response(JSON.stringify({ error: "Failed to record payment" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Payment recorded:", metadata.reference, "Amount:", totalBaseAmount);

    return new Response(
      JSON.stringify({ received: true, reference: metadata.reference, amount: totalBaseAmount }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
