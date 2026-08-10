// squad-webhook
//
// Receives Squad events, verifies the x-squad-encrypted-body signature
// (HMAC-SHA512 of the RAW body with the secret key), and settles the payment
// idempotently.
//
// Point Squad's webhook URL at:
//   https://<project-ref>.supabase.co/functions/v1/squad-webhook
//
// verify_jwt is false for this function because Squad calls it server-to-server
// and holds no Supabase JWT. The signature IS the authorization — if it does not
// verify, nothing is written.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { squad } from "../_shared/gateways.ts";
import { settlePayment, markFailed } from "../_shared/recordPayment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-squad-encrypted-body, x-squad-signature",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Squad echoes the payer's details back on every event. We have no use for them
// and no reason to retain them, so they never reach the audit table.
//
// The field names come from Squad's documented webhook payload (verified
// 2026-08-10): `payment_information` carries card details on card payments and
// `customer_mobile` the payer's phone on USSD. Both were missed on the first
// pass, which had been guessing at names like `card` and `payer_details` that
// Squad does not actually use — so card data WAS reaching payment_events.
const REDACT_FIELDS = [
  "payment_information", // card details (card payments)
  "customer_mobile",     // payer phone (USSD)
  "email",
  "customer",
  "customer_email",
  "ip_address",
];

const redact = (payload: Record<string, unknown>): Record<string, unknown> => {
  const clone = JSON.parse(JSON.stringify(payload ?? {}));
  for (const key of ["Body", "body", "data"]) {
    const c = clone?.[key];
    if (c && typeof c === "object") {
      for (const f of REDACT_FIELDS) delete c[f];
    }
  }
  return clone;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const rawBody = await req.text();
    if (!rawBody) return json({ received: true, ignored: "empty body" });

    if (!squad.secret()) {
      console.error("SQUAD_SECRET_KEY not set — rejecting webhook");
      return json({ error: "not configured" }, 401);
    }

    // Signature over the RAW body, before any parsing.
    if (!(await squad.verifyWebhook(rawBody, req.headers))) {
      console.warn("Squad webhook rejected: signature mismatch");
      return json({ error: "Invalid signature" }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const parsed = squad.parseWebhook(payload);

    await supabaseAdmin.from("payment_events").insert({
      event_type: parsed.event || null,
      payment_id: parsed.reference || null,
      status: parsed.success ? "success" : parsed.failed ? "failed" : parsed.event,
      amount_usd: null,
      payload: redact(payload),
    });

    if (parsed.failed) {
      await markFailed(supabaseAdmin, parsed.reference, "squad-webhook");
      return json({ received: true, marked: "failed", reference: parsed.reference });
    }

    if (!parsed.success) {
      return json({ received: true, ignored: parsed.event });
    }

    const settled = await settlePayment(supabaseAdmin, {
      reference: parsed.reference,
      amountPaidKobo: parsed.amountPaidKobo,
      metadata: parsed.metadata,
      gateway: "squad",
      source: "squad-webhook",
    });

    return json({ received: true, reference: parsed.reference, ...settled });
  } catch (error) {
    console.error("Squad webhook error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
