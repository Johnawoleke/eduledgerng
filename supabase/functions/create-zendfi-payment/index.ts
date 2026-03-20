import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const NGN_TO_USD_RATE = 1500;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { school_slug, student_id, pin, fee_payments } = await req.json();

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

    // Verify school
    const { data: school } = await supabaseAdmin
      .from("schools")
      .select("id, name")
      .eq("slug", school_slug)
      .maybeSingle();

    if (!school) {
      return new Response(
        JSON.stringify({ error: "School not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify student credentials
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

    // Get class-level fees for this student's class (matching exact class OR "ALL")
    const { data: classFees } = await supabaseAdmin
      .from("class_fees")
      .select("*")
      .eq("school_id", school.id)
      .in("class_target", [student.class, "ALL"]);

    // Get existing payments for this student to calculate paid amounts
    const { data: existingPayments } = await supabaseAdmin
      .from("payments")
      .select("items")
      .eq("student_id", student.id);

    // Build a map of fee name -> total paid (same logic as student-auth)
    const paidMap: Record<string, number> = {};
    (existingPayments || []).forEach((p: any) => {
      (p.items || []).forEach((item: string) => {
        const pipeIdx = item.lastIndexOf("|");
        if (pipeIdx > 0) {
          const itemName = item.substring(0, pipeIdx);
          const itemAmount = Number(item.substring(pipeIdx + 1));
          if (!isNaN(itemAmount)) {
            paidMap[itemName] = (paidMap[itemName] || 0) + itemAmount;
          }
        }
      });
    });

    // Validate fee_payments against class fees
    let totalNGN = 0;
    const validatedItems: { fee_item_id: string; amount: number; name: string }[] = [];

    for (const fp of fee_payments) {
      const classFee = (classFees || []).find((cf: any) => cf.id === fp.fee_item_id);
      if (!classFee) continue;

      const totalPaid = Math.min(paidMap[classFee.name] || 0, Number(classFee.amount));
      const owing = Number(classFee.amount) - totalPaid;
      const payAmount = Math.min(Math.max(fp.amount, 0), owing);
      if (payAmount <= 0) continue;

      totalNGN += payAmount;
      validatedItems.push({ fee_item_id: fp.fee_item_id, amount: payAmount, name: classFee.name });
    }

    if (totalNGN <= 0) {
      return new Response(
        JSON.stringify({ error: "No valid payments" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Convert to USD
    const amountUSD = Math.ceil((totalNGN / NGN_TO_USD_RATE) * 100) / 100;

    // Generate internal reference
    const reference = `EDU-${Date.now().toString(36).toUpperCase()}`;

    // Create Zendfi payment link
    const zendfiKey = Deno.env.get("ZENDFI_TEST_KEY");
    if (!zendfiKey) {
      return new Response(
        JSON.stringify({ error: "Payment provider not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch parent_email from the student record
    const { data: studentRecord } = await supabaseAdmin
      .from("students")
      .select("parent_email")
      .eq("id", student.id)
      .maybeSingle();

    const customerEmail = studentRecord?.parent_email || `${student_id}@${school_slug}.eduledger.ng`;

    const zendfiPayload = {
      amount: amountUSD,
      currency: "USD",
      description: `EduLedgerNG - School Fee Payment`,
      onramp: true,
      payer_service_charge: true,
      customer: {
        email: customerEmail,
        name: student.name,
      },
      metadata: {
        reference,
        school_id: school.id,
        student_db_id: student.id,
        student_id,
        school_slug,
        total_ngn: totalNGN,
        items: validatedItems,
      },
    };

    const zendfiRes = await fetch("https://api.zendfi.tech/api/v1/payment-links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${zendfiKey}`,
      },
      body: JSON.stringify(zendfiPayload),
    });

    const zendfiText = await zendfiRes.text();
    console.log("Zendfi response status:", zendfiRes.status, "body:", zendfiText);

    let zendfiData: any;
    try {
      zendfiData = JSON.parse(zendfiText);
    } catch {
      console.error("Zendfi returned non-JSON:", zendfiText);
      return new Response(
        JSON.stringify({ error: "Payment provider returned an invalid response", details: zendfiText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!zendfiRes.ok || !zendfiData.hosted_page_url) {
      console.error("Zendfi API error:", JSON.stringify(zendfiData));
      return new Response(
        JSON.stringify({ error: "Failed to create payment link", details: zendfiData }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        hosted_page_url: zendfiData.hosted_page_url,
        reference,
        amount_ngn: totalNGN,
        amount_usd: amountUSD,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
