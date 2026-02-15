import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { school_slug, student_id, pin, fee_payments } = await req.json();
    // fee_payments: Array<{ fee_item_id: string, amount: number }>

    if (!school_slug || !student_id || !pin || !fee_payments?.length) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify student
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

    const { data: student } = await supabaseAdmin
      .from("students")
      .select("id, name, class")
      .eq("school_id", school.id)
      .eq("student_id", student_id)
      .eq("pin", pin)
      .maybeSingle();

    if (!student) {
      return new Response(
        JSON.stringify({ error: "Invalid credentials" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const reference = `PSK-${Date.now().toString(36).toUpperCase()}`;
    let totalAmount = 0;
    const itemNames: string[] = [];

    // Process each fee payment
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
      itemNames.push(
        newStatus === "paid" ? feeItem.name : `${feeItem.name} (partial)`
      );
    }

    if (totalAmount <= 0) {
      return new Response(
        JSON.stringify({ error: "No valid payments" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create payment record
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
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
