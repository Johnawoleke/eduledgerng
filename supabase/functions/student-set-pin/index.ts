// student-set-pin
//
// First-login password set. Verifies the student's CURRENT credential (the
// temporary password the school issued) before writing the new one, then clears
// must_change_pin and hands back a session token so the student lands straight
// in their dashboard.
//
// Two things this function must keep doing:
//   - clear `default_pin`. It previously wrote the student's NEW password into
//     that column in plaintext, which handed every school owner their students'
//     real passwords. default_pin is only ever the issued temporary one.
//   - revoke prior sessions, so anything minted before the change dies.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkStudentPassword } from "../_shared/password.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const clientIp = (req: Request): string =>
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
  req.headers.get("cf-connecting-ip") ||
  "";

const newSessionToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { school_slug, student_id, current_pin, new_pin } = await req.json();

    if (!school_slug || !student_id || !current_pin || !new_pin) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (
      typeof school_slug !== "string" || school_slug.length > 100 ||
      typeof student_id !== "string" || student_id.length > 30 ||
      typeof current_pin !== "string" || current_pin.length > 50
    ) {
      return json({ error: "Invalid input" }, 400);
    }

    const check = checkStudentPassword(new_pin, [student_id]);
    if (!check.ok) {
      return json({ error: check.error }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const ip = clientIp(req);
    const { data: allowed, error: throttleError } = await supabaseAdmin.rpc(
      "student_auth_throttle_check",
      { p_ip: ip }
    );
    if (throttleError) {
      console.error("throttle check failed:", throttleError.message);
      return json({ error: "Service temporarily unavailable. Please try again." }, 503);
    }
    if (allowed === false) {
      return json({ error: "Too many attempts. Please wait 15 minutes and try again." }, 429);
    }

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
      return json({ error: "Current password is incorrect" }, 401);
    }

    const student = students[0];
    const { error: updateError } = await supabaseAdmin
      .from("students")
      .update({
        pin: String(new_pin).trim(),
        default_pin: null,
        must_change_pin: false,
        is_first_login: false,
      })
      .eq("id", student.id);

    if (updateError) {
      console.error("student-set-pin update:", updateError.message);
      return json({ error: "Failed to update password" }, 500);
    }

    await supabaseAdmin.rpc("revoke_student_sessions", { p_student_id: student.id });

    const sessionToken = newSessionToken();
    const { data: expiresAt, error: sessionError } = await supabaseAdmin.rpc(
      "create_student_session",
      {
        p_student_id: student.id,
        p_school_id: school.id,
        p_token: sessionToken,
        p_ttl_hours: 12,
      }
    );
    if (sessionError) {
      console.error("student-set-pin session:", sessionError.message);
      return json({ success: true, reauth_required: true });
    }

    await supabaseAdmin.rpc("student_auth_throttle_reset", { p_ip: ip });

    return json({ success: true, session_token: sessionToken, session_expires_at: expiresAt });
  } catch (err) {
    console.error("Error in student-set-pin:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
