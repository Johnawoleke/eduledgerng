// supabase/functions/add-bursar/index.ts
//
// Restricted to OWNERS of the target school (the caller's JWT is verified).
// The owner provides the bursar's email + a temporary password; this creates
// the auth account directly, adds it to school_admins as a bursar, and returns
// so the owner can share the credentials. The bursar is forced to change the
// password on first login. There is NO invitation flow — an email that already
// has an account is rejected with a clear error.
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
    const { email, schoolId, role, password, fullName } = await req.json();

    if (!email || !schoolId) {
      return json({ error: "Missing required fields" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // --- Verify the CALLER is an owner of this school -----------------------
    const authHeader = req.headers.get("Authorization") || "";
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: callerData } = await callerClient.auth.getUser();
    const caller = callerData?.user;
    if (!caller) {
      return json({ error: "You must be signed in" }, 401);
    }

    const { data: school } = await supabaseAdmin
      .from("schools")
      .select("id, owner_id, name")
      .eq("id", schoolId)
      .maybeSingle();
    if (!school) return json({ error: "School not found" }, 404);

    let isOwner = school.owner_id === caller.id;
    if (!isOwner) {
      const { data: ownerRow } = await supabaseAdmin
        .from("school_admins")
        .select("id")
        .eq("school_id", schoolId)
        .eq("user_id", caller.id)
        .eq("role", "owner")
        .maybeSingle();
      isOwner = !!ownerRow;
    }
    if (!isOwner) {
      return json({ error: "Only school owners can add bursars" }, 403);
    }

    // --- Find target user by email (listUsers is paginated) -----------------
    const target = String(email).toLowerCase();
    let existingUser = null;
    for (let page = 1; page <= 20 && !existingUser; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      existingUser = data.users.find((u) => u.email?.toLowerCase() === target) || null;
      if (data.users.length < 1000) break;
    }

    // Bursars are added ONLY by the owner creating a new account for them and
    // sharing the credentials — there is no invitation flow. An email that
    // already has an account therefore cannot be added; surface a clear error.
    if (existingUser) {
      return json(
        { error: "An account with this email already exists. Use a different email to create a new bursar account." },
        400
      );
    }

    // --- Create the bursar account directly --------------------------------
    if (!password) {
      return json({ error: "A password is required to create the bursar account.", needsPassword: true }, 400);
    }
    if (typeof password !== "string" || password.length < 6) {
      return json({ error: "Password must be at least 6 characters" }, 400);
    }

    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: target,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName || null },
    });
    if (createError || !created?.user) {
      return json({ error: createError?.message || "Failed to create account" }, 400);
    }

    const { error: memberError } = await supabaseAdmin.from("school_admins").insert({
      school_id: schoolId,
      user_id: created.user.id,
      role: role || "bursar",
    });
    if (memberError) {
      // Roll back the orphan account so a retry starts clean
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      return json({ error: memberError.message }, 400);
    }

    // Force the bursar to rotate the owner-chosen temp password on first login.
    const { error: profileError } = await supabaseAdmin.from("profiles").upsert({
      id: created.user.id,
      email: target,
      full_name: fullName || null,
      must_change_password: true,
    });
    if (profileError) {
      // The account + membership exist, but forced rotation didn't get set.
      // Surface it so the owner knows to have the bursar change their password.
      console.error("add-bursar: failed to set must_change_password:", profileError.message);
      return json({
        success: true,
        created: true,
        userId: created.user.id,
        warning: "Account created, but we couldn't flag the temporary password for rotation — ask the bursar to change it after first login.",
        message: "Bursar account created and added to the school. Share the login details with your bursar.",
      });
    }

    return json({
      success: true,
      created: true,
      userId: created.user.id,
      message: "Bursar account created and added to the school. Share the login details with your bursar.",
    });
  } catch (err) {
    console.error("Error in add-bursar:", err);
    return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});
