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
    const { reference, school_slug, student_id, pin, fee_payments } = await req.json();

    if (!reference || !school_slug || !student_id || !pin || !fee_payments?.length) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Verify with Paystack
    const paystackKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackKey) {
      return new Response(
        JSON.stringify({ error: "Payment gateway not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${paystackKey}` },
    });
    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data?.status !== "success") {
      return new Response(
        JSON.stringify({ error: "Payment verification failed", details: verifyData.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const paystackAmount = verifyData.data.amount; // in kobo

    // 2. Authenticate student
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: school } = await supabaseAdmin
      .from("schools")
      .select("id")
      .eq("slug", school_slug)
      .maybeSingle();

    if (!school) {
      return new Response(
        JSON.stringify({ error: "School not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: students, error: verifyError } = await supabaseAdmin
      .rpc("verify_student_pin", {
        p_school_id: school.id,
        p_student_id: student_id,
        p_pin: pin,
      });

    if (verifyError || !students || students.length === 0) {
      return new Response(
        JSON.stringify({ error: "Invalid credentials" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const student = students[0];

    // 3. Check for duplicate reference
    const { data: existingPayment } = await supabaseAdmin
      .from("payments")
      .select("id")
      .eq("reference", reference)
      .maybeSingle();

    if (existingPayment) {
      return new Response(
        JSON.stringify({ error: "Payment already recorded", payment: existingPayment }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Process fee items
    let totalAmount = 0;
    const itemNames: string[] = [];

    for (const fp of fee_payments) {
      const { data: feeItem } = await supabaseAdmin
        .from("fee_items")
        .select("*")
        .eq("id", fp.fee_item_id)
        .eq("student_id", student.id)
        .maybeSingle();

      if (!feeItem) continue;

      const owing = feeItem.amount - feeItem.paid;
      const payAmount = Math.min(Math.max(fp.amount, 0), owing);
      if (payAmount <= 0) continue;

      const newPaid = feeItem.paid + payAmount;
      const newStatus = newPaid >= feeItem.amount ? "paid" : "partial";

      await supabaseAdmin
        .from("fee_items")
        .update({ paid: newPaid, status: newStatus })
        .eq("id", fp.fee_item_id);

      totalAmount += payAmount;
      const label = newStatus === "paid" ? feeItem.name : `${feeItem.name} (partial)`;
      itemNames.push(`${label}|${payAmount}`);
    }

    // 5. Validate amount matches Paystack (kobo → naira)
    const paystackNaira = paystackAmount / 100;
    if (Math.abs(paystackNaira - totalAmount) > 1) {
      console.warn(`Amount mismatch: Paystack=${paystackNaira}, calculated=${totalAmount}`);
    }

    if (totalAmount <= 0) {
      return new Response(
        JSON.stringify({ error: "No valid payments" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Record payment
    const { data: payment, error: payError } = await supabaseAdmin
      .from("payments")
      .insert({
        school_id: school.id,
        student_id: student.id,
        amount: totalAmount,
        reference,
        method: "Paystack",
        items: itemNames,
      })
      .select()
      .single();

    if (payError) {
      return new Response(
        JSON.stringify({ error: "Failed to record payment" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ payment, totalAmount, reference }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("verify-payment error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
