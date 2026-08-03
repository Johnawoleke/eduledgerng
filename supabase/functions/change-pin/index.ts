// change-pin
//
// In-session password change. The student proves knowledge of the CURRENT
// password (re-auth — a session token alone must not be enough to change a
// password, or a stolen token becomes permanent account ownership).
//
// On success every existing session for that student is revoked and a fresh one
// is minted, so a token stolen before the change stops working immediately.
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
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { school_slug, student_id, old_pin, new_pin } = await req.json();

    if (!school_slug || !student_id || !old_pin || !new_pin) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (
      typeof school_slug !== "string" || school_slug.length > 100 ||
      typeof student_id !== "string" || student_id.length > 30 ||
      typeof old_pin !== "string" || old_pin.length > 50
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

    // This verifies a password, so it is throttled like a login.
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

    if (!school) {
      return json({ error: "School not found" }, 404);
    }

    const { data: students, error: verifyError } = await supabaseAdmin.rpc("verify_student_pin", {
      p_school_id: school.id,
      p_student_id: student_id,
      p_pin: old_pin,
    });

    if (verifyError || !students || students.length === 0) {
      return json({ error: "Invalid current password" }, 401);
    }

    const student = students[0];

    // The pin column is hashed by the hash_student_pin trigger on write.
    // default_pin is cleared: it exists only to show the owner the temporary
    // password they issued, and must never hold a password the student chose.
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
      console.error("change-pin update:", updateError.message);
      return json({ error: "Failed to update password" }, 500);
    }

    // Kill every session that existed under the old password, then issue one
    // for the caller so they stay logged in on this device only.
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
      // The password change itself succeeded; make the client log in again.
      console.error("change-pin session:", sessionError.message);
      return json({ success: true, reauth_required: true });
    }

    await supabaseAdmin.rpc("student_auth_throttle_reset", { p_ip: ip });

    return json({ success: true, session_token: sessionToken, session_expires_at: expiresAt });
  } catch (err) {
    console.error("Error in change-pin:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
