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
    const { school_slug, student_id, pin, session_id, term_id } = await req.json();

    // Validate required fields
    if (!school_slug || !student_id || !pin) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate input types and lengths
    // PIN max must match what the setters allow (student-set-pin caps at 50),
    // otherwise a student who chose a >10-char password is locked out at login.
    if (typeof student_id !== "string" || student_id.length > 30 ||
        typeof pin !== "string" || pin.length > 50 ||
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

    if (schoolError) {
      return new Response(
        JSON.stringify({ error: "Database connection error", details: schoolError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!school) {
      return new Response(
        JSON.stringify({ error: "School not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify student PIN using RPC
    const { data: students, error: verifyError } = await supabaseAdmin
      .rpc("verify_student_pin", {
        p_school_id: school.id,
        p_student_id: student_id,
        p_pin: pin,
      });

    if (verifyError) {
      return new Response(
        JSON.stringify({ error: "Database connection error", details: verifyError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!students || students.length === 0) {
      return new Response(
        JSON.stringify({ error: "Invalid Student ID or PIN" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const student = students[0];

    // Build fee query - only PUBLISHED fees are visible to students,
    // filtered by session_id and term_id if provided
    let feeQuery = supabaseAdmin
      .from("class_fees")
      .select("*")
      .eq("school_id", school.id)
      .eq("status", "published")
      .in("class_target", [student.class, "ALL"]);

    if (session_id) feeQuery = feeQuery.eq("session_id", session_id);
    if (term_id) feeQuery = feeQuery.eq("term_id", term_id);

    const { data: classFees, error: feesError } = await feeQuery;

    if (feesError) {
      return new Response(
        JSON.stringify({ error: "Database connection error", details: feesError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build payments query - filter by session_id and term_id if provided
    let paymentQuery = supabaseAdmin
      .from("payments")
      .select("*")
      .eq("student_id", student.id)
      .order("date", { ascending: false });

    if (session_id) paymentQuery = paymentQuery.eq("session_id", session_id);
    if (term_id) paymentQuery = paymentQuery.eq("term_id", term_id);

    const { data: payments, error: paymentsError } = await paymentQuery;

    if (paymentsError) {
      return new Response(
        JSON.stringify({ error: "Database connection error", details: paymentsError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build fee items with paid amounts calculated from filtered payments
    const feeItems = (classFees || []).map((cf: any) => {
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
        session_id: cf.session_id || null,
        term_id: cf.term_id || null,
      };
    });

    // Load sessions for the school
    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from("sessions")
      .select("id, name, start_year, end_year")
      .eq("school_id", school.id)
      .order("name", { ascending: true });

    if (sessionsError) {
      return new Response(
        JSON.stringify({ error: "Database connection error", details: sessionsError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Load terms for the school
    const { data: terms, error: termsError } = await supabaseAdmin
      .from("terms")
      .select("id, session_id, name, term_number")
      .eq("school_id", school.id)
      .order("term_number", { ascending: true });

    if (termsError) {
      return new Response(
        JSON.stringify({ error: "Database connection error", details: termsError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        student,
        school,
        feeItems,
        payments: payments || [],
        sessions: sessions || [],
        terms: terms || [],
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: "Internal server error", details: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
