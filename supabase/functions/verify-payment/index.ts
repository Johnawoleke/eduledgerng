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

    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${paystackKey}` } }
    );
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
      .select("id, name, slug")
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

    // 4. Get the class fees for this student to validate fee items
    const { data: classFees } = await supabaseAdmin
      .from("class_fees")
      .select("*")
      .eq("school_id", school.id)
      .in("class_target", [student.class, "ALL"]);

    // Get existing payments to calculate current paid amounts
    const { data: existingPayments } = await supabaseAdmin
      .from("payments")
      .select("items")
      .eq("student_id", student.id);

    // Calculate how much has already been paid per fee name
    const paidByFee: Record<string, number> = {};
    (existingPayments || []).forEach((p: any) => {
      (p.items || []).forEach((item: string) => {
        const pipeIdx = item.lastIndexOf("|");
        if (pipeIdx > 0) {
          const itemName = item.substring(0, pipeIdx);
          const itemAmount = Number(item.substring(pipeIdx + 1));
          if (!isNaN(itemAmount)) {
            paidByFee[itemName] = (paidByFee[itemName] || 0) + itemAmount;
          }
        }
      });
    });

    // 5. Process fee payments
    let totalAmount = 0;
    const itemNames: string[] = [];

    for (const fp of fee_payments) {
      // fp has: fee_item_id (class_fees.id), amount
      const classFee = (classFees || []).find((cf: any) => cf.id === fp.fee_item_id);
      if (!classFee) continue;

      const alreadyPaid = paidByFee[classFee.name] || 0;
      const owing = Math.max(Number(classFee.amount) - alreadyPaid, 0);
      const payAmount = Math.min(Math.max(Number(fp.amount), 0), owing);
      if (payAmount <= 0) continue;

      totalAmount += payAmount;
      const newPaid = alreadyPaid + payAmount;
      const isFullyPaid = newPaid >= Number(classFee.amount);
      const label = isFullyPaid ? classFee.name : `${classFee.name} (partial)`;
      itemNames.push(`${label}|${payAmount}`);
    }

    // 6. Validate amount loosely against Paystack
    const paystackNaira = paystackAmount / 100;
    if (Math.abs(paystackNaira - totalAmount) > 1) {
      console.warn(`Amount mismatch: Paystack=${paystackNaira}, calculated=${totalAmount}`);
    }

    if (totalAmount <= 0) {
      return new Response(
        JSON.stringify({ error: "No valid payments to record" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 7. Record payment
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
      console.error("Payment insert error:", payError);
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
