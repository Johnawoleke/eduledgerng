import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function verifySignature(body: string, signature: string | null): Promise<{ valid: boolean; reason: string }> {
  const secret = Deno.env.get("ZENDFI_WEBHOOK_SECRET");
  
  if (!secret) {
    console.warn("ZENDFI_WEBHOOK_SECRET not set - skipping verification");
    return { valid: true, reason: "no_secret_configured" };
  }

  if (!signature) {
    console.warn("No X-Zendfi-Signature header present - rejecting");
    return { valid: false, reason: "missing_signature" };
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expectedSignature = new TextDecoder().decode(hexEncode(new Uint8Array(signatureBuffer)));

  // Constant-time comparison
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
    const signature = req.headers.get("x-zendfi-signature");
    console.log("Webhook signature:", signature || "none");

    const bodyText = await req.text();
    console.log("Zendfi webhook raw body:", bodyText);

    if (!bodyText || bodyText.trim().length === 0) {
      console.log("Empty body received, returning 200");
      return new Response(JSON.stringify({ received: true, ignored: "empty body" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify webhook signature
    const verification = await verifySignature(bodyText, signature);
    console.log("Signature verification:", verification.reason);
    if (!verification.valid) {
      console.error("Webhook signature verification failed:", verification.reason);
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let payload: any;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      console.error("Invalid JSON body");
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Zendfi webhook parsed:", JSON.stringify(payload));

    const status = payload?.status || payload?.data?.status || payload?.event;
    if (status !== "completed" && status !== "successful" && status !== "payment.successful") {
      console.log("Non-success status, ignoring:", status);
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const metadata = payload?.metadata || payload?.data?.metadata;
    if (!metadata?.reference || !metadata?.school_id || !metadata?.student_db_id || !metadata?.items) {
      console.error("Missing metadata in webhook payload");
      return new Response(JSON.stringify({ error: "Missing metadata" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Idempotency check
    const { data: existingPayment } = await supabaseAdmin
      .from("payments")
      .select("id")
      .eq("reference", metadata.reference)
      .maybeSingle();

    if (existingPayment) {
      console.log("Payment already processed:", metadata.reference);
      return new Response(JSON.stringify({ received: true, already_processed: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use base_amount (excluding service charges) for recording
    let totalBaseAmount = 0;
    const itemNames: string[] = [];

    for (const item of metadata.items) {
      const payAmount = Math.max(Number(item.amount), 0);
      if (payAmount <= 0) continue;
      totalBaseAmount += payAmount;
      itemNames.push(`${item.name}|${payAmount}`);
    }

    if (totalBaseAmount <= 0) {
      console.error("No valid fee updates for reference:", metadata.reference);
      return new Response(JSON.stringify({ error: "No valid payments" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Record payment with base amount only (no service charges)
    const { error: payError } = await supabaseAdmin
      .from("payments")
      .insert({
        school_id: metadata.school_id,
        student_id: metadata.student_db_id,
        amount: totalBaseAmount,
        reference: metadata.reference,
        method: "Bank Transfer (Zendfi)",
        items: itemNames,
      });

    if (payError) {
      console.error("Failed to insert payment:", payError);
      return new Response(JSON.stringify({ error: "Failed to record payment" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Payment recorded successfully:", metadata.reference, "Base amount:", totalBaseAmount);
    console.log("Service charges - Platform:", metadata.platform_fee, "Gateway:", metadata.gateway_fee, "Bank:", metadata.bank_charge, "Total charged:", metadata.total_ngn);

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
