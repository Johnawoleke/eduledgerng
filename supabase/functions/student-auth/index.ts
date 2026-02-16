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
    const { school_slug, student_id, pin } = await req.json();

    if (!school_slug || !student_id || !pin) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (typeof student_id !== "string" || student_id.length > 30 ||
        typeof pin !== "string" || pin.length > 10 ||
        typeof school_slug !== "string" || school_slug.length > 100) {
      return new Response(
        JSON.stringify({ error: "Invalid input" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Find school by slug
    const { data: school, error: schoolError } = await supabaseAdmin
      .from("schools")
      .select("id, name")
      .eq("slug", school_slug)
      .maybeSingle();

    if (schoolError || !school) {
      return new Response(
        JSON.stringify({ error: "School not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify student PIN
    const { data: students, error: verifyError } = await supabaseAdmin
      .rpc("verify_student_pin", {
        p_school_id: school.id,
        p_student_id: student_id,
        p_pin: pin,
      });

    if (verifyError || !students || students.length === 0) {
      return new Response(
        JSON.stringify({ error: "Invalid Student ID or PIN" }),
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

    // Get payments for this student
    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("student_id", student.id)
      .order("date", { ascending: false });

    // Build fee items with paid amounts calculated from payments
    const feeItems = (classFees || []).map((cf: any) => {
      // Sum paid amounts from payment items matching this fee name
      let totalPaid = 0;
      (payments || []).forEach((p: any) => {
        (p.items || []).forEach((item: string) => {
          const pipeIdx = item.lastIndexOf("|");
          if (pipeIdx > 0) {
            const itemName = item.substring(0, pipeIdx);
            const itemAmount = Number(item.substring(pipeIdx + 1));
            if (itemName === cf.name && !isNaN(itemAmount)) {
              totalPaid += itemAmount;
            }
          }
        });
      });

      const paid = Math.min(totalPaid, Number(cf.amount));
      return {
        id: cf.id,
        name: cf.name,
        amount: Number(cf.amount),
        paid,
        status: paid >= Number(cf.amount) ? "paid" : paid > 0 ? "partial" : "unpaid",
      };
    });

    return new Response(
      JSON.stringify({
        student,
        school,
        feeItems,
        payments: payments || [],
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
