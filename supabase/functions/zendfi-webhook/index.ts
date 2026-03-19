import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    console.log("Zendfi webhook received:", JSON.stringify(payload));

    // Check for successful payment event
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

    // Check if this payment was already processed (idempotency)
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

    // Update fee items
    let totalAmount = 0;
    const itemNames: string[] = [];

    for (const item of metadata.items) {
      const { data: feeItem } = await supabaseAdmin
        .from("fee_items")
        .select("*")
        .eq("id", item.fee_item_id)
        .eq("student_id", metadata.student_db_id)
        .maybeSingle();

      if (!feeItem) continue;

      const owing = feeItem.amount - feeItem.paid;
      const payAmount = Math.min(Math.max(item.amount, 0), owing);
      if (payAmount <= 0) continue;

      const newPaid = feeItem.paid + payAmount;
      const newStatus = newPaid >= feeItem.amount ? "paid" : "partial";

      await supabaseAdmin
        .from("fee_items")
        .update({ paid: newPaid, status: newStatus })
        .eq("id", item.fee_item_id);

      totalAmount += payAmount;
      const label = newStatus === "paid" ? item.name : `${item.name} (partial)`;
      itemNames.push(`${label}|${payAmount}`);
    }

    if (totalAmount <= 0) {
      console.error("No valid fee updates for reference:", metadata.reference);
      return new Response(JSON.stringify({ error: "No valid payments" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Record payment
    const { error: payError } = await supabaseAdmin
      .from("payments")
      .insert({
        school_id: metadata.school_id,
        student_id: metadata.student_db_id,
        amount: totalAmount,
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

    console.log("Payment processed successfully:", metadata.reference, "Amount:", totalAmount);

    return new Response(
      JSON.stringify({ received: true, reference: metadata.reference, amount: totalAmount }),
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
