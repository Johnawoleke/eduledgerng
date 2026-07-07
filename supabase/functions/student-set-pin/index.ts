// student-set-pin
//
// First-login password/PIN set for a student. Verifies the student's CURRENT
// credential server-side (via verify_student_pin) before writing the new one,
// so the students table no longer needs an anon-writable UPDATE policy.
// Replaces the old direct-from-browser update in ResetPassword.tsx.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { school_slug, student_id, current_pin, new_pin } = await req.json();

    if (!school_slug || !student_id || !current_pin || !new_pin) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (typeof new_pin !== "string" || new_pin.length < 4 || new_pin.length > 50) {
      return json({ error: "New password must be at least 4 characters" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: school } = await supabaseAdmin
      .from("schools")
      .select("id")
      .eq("slug", school_slug)
      .maybeSingle();
    if (!school) return json({ error: "School not found" }, 404);

    // Prove the caller knows the current credential (with lockout protection).
    const { data: students, error: verifyError } = await supabaseAdmin.rpc("verify_student_pin", {
      p_school_id: school.id,
      p_student_id: student_id,
      p_pin: current_pin,
    });
    if (verifyError || !students || students.length === 0) {
      return json({ error: "Current PIN is incorrect" }, 401);
    }

    const student = students[0];
    const { error: updateError } = await supabaseAdmin
      .from("students")
      .update({
        pin: new_pin,
        default_pin: new_pin,
        must_change_pin: false,
        is_first_login: false,
      })
      .eq("id", student.id);

    if (updateError) {
      return json({ error: "Failed to update password" }, 500);
    }

    return json({ success: true });
  } catch (err) {
    console.error("Error in student-set-pin:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
