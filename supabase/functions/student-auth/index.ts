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

    // Basic input validation
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

    // Verify student PIN using secure database function (hashed comparison + rate limiting)
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

    // Get fee items for this student
    let { data: feeItems } = await supabaseAdmin
      .from("fee_items")
      .select("*")
      .eq("student_id", student.id);

    // Auto-provision fees from classmates if student has none
    if (!feeItems || feeItems.length === 0) {
      // Find a classmate in the same school+class who has fee_items
      const { data: classmates } = await supabaseAdmin
        .from("students")
        .select("id")
        .eq("school_id", student.school_id)
        .eq("class", student.class)
        .neq("id", student.id)
        .limit(50);

      if (classmates && classmates.length > 0) {
        // Get fee_items from the first classmate who has them
        let templateFees: any[] = [];
        for (const classmate of classmates) {
          const { data: classFees } = await supabaseAdmin
            .from("fee_items")
            .select("name, amount, school_id")
            .eq("student_id", classmate.id)
            .eq("school_id", student.school_id);
          if (classFees && classFees.length > 0) {
            templateFees = classFees;
            break;
          }
        }

        if (templateFees.length > 0) {
          const inserts = templateFees.map((f: any) => ({
            school_id: student.school_id,
            student_id: student.id,
            name: f.name,
            amount: Number(f.amount),
            paid: 0,
            status: "unpaid",
          }));

          await supabaseAdmin.from("fee_items").insert(inserts);

          // Re-fetch the newly created fee items
          const { data: newFees } = await supabaseAdmin
            .from("fee_items")
            .select("*")
            .eq("student_id", student.id);
          feeItems = newFees;
        }
      }
    }

    // Get payments
    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("student_id", student.id)
      .order("date", { ascending: false });

    return new Response(
      JSON.stringify({
        student,
        school,
        feeItems: feeItems || [],
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
