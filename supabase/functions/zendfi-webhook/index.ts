import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLAY_TOLERANCE_SECONDS = 300; // per Zendfi security docs

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return new TextDecoder().decode(hexEncode(new Uint8Array(buf)));
}

// Zendfi's two docs pages describe two different signature formats. We accept both.
//   Format A (api-reference/webhooks): header = "t=<unix>,v1=<hex>", signed payload = "<timestamp>.<body>"
//   Format B (security/webhooks):      header = "<hex>", timestamp in separate X-ZendFi-Timestamp header,
//                                      signed payload = "<body>" (or "<timestamp>.<body>" as fallback)
async function verifySignature(body: string, req: Request): Promise<{ valid: boolean; reason: string }> {
  const secret = Deno.env.get("ZENDFI_WEBHOOK_SECRET");
  if (!secret) {
    console.error("ZENDFI_WEBHOOK_SECRET not set - rejecting webhook");
    return { valid: false, reason: "no_secret_configured" };
  }

  const sigHeader = req.headers.get("x-zendfi-signature");
  const tsHeader = req.headers.get("x-zendfi-timestamp");
  if (!sigHeader) {
    return { valid: false, reason: "missing_signature" };
  }

  // Detect format A (contains "t=" and/or "v1=") vs format B (bare hex)
  const looksLikeFormatA = /(^|,)\s*(t|v1)\s*=/.test(sigHeader);

  let providedSig: string;
  let timestamp: string | undefined;

  if (looksLikeFormatA) {
    const parts: Record<string, string> = {};
    for (const part of sigHeader.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) parts[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
    }
    timestamp = parts["t"] || tsHeader?.trim();
    providedSig = parts["v1"] || "";
    if (!providedSig) return { valid: false, reason: "malformed_signature_header" };
  } else {
    providedSig = sigHeader.trim();
    timestamp = tsHeader?.trim();
  }

  // Replay protection — if a timestamp is provided, enforce the 5-min tolerance window
  if (timestamp) {
    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum)) {
      return { valid: false, reason: "invalid_timestamp" };
    }
    // Accept both seconds and milliseconds unix timestamps
    const tsSeconds = tsNum > 1e12 ? tsNum / 1000 : tsNum;
    const nowSeconds = Date.now() / 1000;
    if (Math.abs(nowSeconds - tsSeconds) > REPLAY_TOLERANCE_SECONDS) {
      return { valid: false, reason: "timestamp_outside_tolerance" };
    }
  }

  // Try both possible signed-payload forms; accept if either matches
  const candidates: string[] = [];
  if (timestamp) candidates.push(`${timestamp}.${body}`);
  candidates.push(body);

  for (const candidate of candidates) {
    const expected = await hmacHex(secret, candidate);
    if (constantTimeEqual(expected, providedSig)) {
      return { valid: true, reason: "signature_verified" };
    }
  }

  return { valid: false, reason: "signature_mismatch" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const bodyText = await req.text();

    if (!bodyText || bodyText.trim().length === 0) {
      return new Response(JSON.stringify({ received: true, ignored: "empty body" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const verification = await verifySignature(bodyText, req);
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
    // Prefer the X-ZendFi-Event header when present (security/webhooks docs say it's authoritative).
    const eventName: string | undefined = req.headers.get("x-zendfi-event") || payload?.event;
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
    // The two docs pages disagree on event-name casing ("PaymentConfirmed" vs "payment.confirmed"),
    // so we accept both plus a few related success events and alternate status strings.
    const normalizedEvent = (eventName || "").toLowerCase().replace(/[._-]/g, "");
    const isSuccessEvent =
      normalizedEvent === "paymentconfirmed" ||
      normalizedEvent === "paymentintentsucceeded" ||
      normalizedEvent === "paymentsucceeded" ||
      normalizedEvent === "paymentsuccessful" ||
      normalizedEvent === "paymentcompleted" ||
      normalizedEvent === "invoicepaid" ||
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
