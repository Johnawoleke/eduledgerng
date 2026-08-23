// verify-payment
//
// Called by the student dashboard when a gateway redirects back with a
// reference. Replaces verify-paystack-payment and works for any gateway: the
// provider is read off the payments row (falling back to the reference prefix
// for a row that was never written), then that adapter confirms the charge.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { gatewayFor } from "../_shared/gateways.ts";
import { settlePayment, markFailed, FAILURE_REASONS } from "../_shared/recordPayment.ts";
import type { GatewayId } from "../_shared/gatewayMoney.ts";

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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { reference } = await req.json();
    if (!reference || typeof reference !== "string" || reference.length > 100) {
      return json({ error: "Missing reference" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Which gateway took this payment? The row knows. Paystack is the only
    // provider, so the lookup is redundant today — it is kept because it is
    // what lets a second gateway be routed in without touching this function,
    // and because rows written during the Squad episode carry gateway values
    // that must not be silently reinterpreted.
    const { data: row } = await supabaseAdmin
      .from("payments")
      .select("gateway")
      .eq("reference", reference)
      .maybeSingle();

    const gatewayId: GatewayId = (row?.gateway as GatewayId) ?? "paystack";
    const gateway = gatewayFor(gatewayId);
    if (!gateway.secret()) return json({ error: "Payment provider not configured" }, 500);

    let result;
    try {
      result = await gateway.verify(reference);
    } catch (err) {
      console.error(`${gatewayId} verify failed:`, err);
      return json({ success: false, status: "not_found" }, 404);
    }

    if (!result.success) {
      // Only write the attempt off when the gateway says it is actually over.
      // This used to call markFailed on ANY non-success, including "pending" —
      // which is the normal reply for a bank transfer the payer has just
      // authorised, since the dashboard verifies the moment checkout redirects
      // back. That flipped a live payment to failed; if the webhook was then
      // missed, the money stayed collected while create-payment stopped
      // counting the row as settled and asked the student to pay again.
      if (result.failed) {
        await markFailed(supabaseAdmin, reference, `verify.${gatewayId}`);
      }
      return json({
        success: false,
        status: result.status || "pending",
        ...(result.failed ? { reason: FAILURE_REASONS.declined } : {}),
      });
    }

    const settled = await settlePayment(supabaseAdmin, {
      reference,
      amountPaidKobo: result.amountPaidKobo,
      metadata: result.metadata,
      gateway: gatewayId,
      source: `verify.${gatewayId}`,
    });

    // The payer sent a different amount than we asked for. Paystack rejects and
    // refunds that automatically; say so, rather than leaving them looking at a
    // payment that never resolves after they have just sent money.
    if (settled.note === "amount_mismatch") {
      return json({
        success: false,
        status: "amount_mismatch",
        reason: FAILURE_REASONS.wrong_amount,
      });
    }
    return json({ success: true, recorded: settled.recorded, note: settled.note });
  } catch (error) {
    console.error("Error in verify-payment:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
