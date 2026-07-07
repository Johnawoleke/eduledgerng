// supabase/functions/add-bursar/index.ts
//
// Two modes, both restricted to OWNERS of the target school (the caller's JWT
// is verified — previously anyone could invoke this):
//   1. Target email already has an account  -> create a pending invitation
//      (the user accepts it from their main dashboard).
//   2. Target email has no account and a password is provided -> create the
//      auth account directly, add it to school_admins as bursar, and let the
//      owner share the credentials with the bursar.
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

    // =========================================================================
    // MODE 2: account does not exist — create it directly as a bursar
    // =========================================================================
    if (!existingUser) {
      if (!password) {
        return json({ error: "User not found. Provide a password to create the bursar account.", needsPassword: true }, 404);
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
      await supabaseAdmin.from("profiles").upsert({
        id: created.user.id,
        email: target,
        full_name: fullName || null,
        must_change_password: true,
      });

      return json({
        success: true,
        created: true,
        userId: created.user.id,
        message: "Bursar account created and added to the school. Share the login details with your bursar.",
      });
    }

    // =========================================================================
    // MODE 1: account exists — send an invitation (unchanged behavior)
    // =========================================================================
    const userId = existingUser.id;

    const { data: existingMember } = await supabaseAdmin
      .from("school_admins")
      .select("id")
      .eq("school_id", schoolId)
      .eq("user_id", userId)
      .maybeSingle();
    if (existingMember) {
      return json({ error: "User is already a member of this school" }, 400);
    }

    const { data: existingRequest } = await supabaseAdmin
      .from("school_requests")
      .select("id, status, expires_at")
      .eq("school_id", schoolId)
      .eq("user_id", userId)
      .eq("status", "pending")
      .maybeSingle();
    if (existingRequest) {
      // A still-valid pending invite blocks a duplicate; an EXPIRED one is a
      // dead end (hidden from the invitee), so clear it and re-send instead.
      if (new Date(existingRequest.expires_at) > new Date()) {
        return json({ error: "A pending invitation already exists for this user" }, 400);
      }
      await supabaseAdmin.from("school_requests").delete().eq("id", existingRequest.id);
    }

    const { data: request, error: requestError } = await supabaseAdmin
      .from("school_requests")
      .insert({
        school_id: schoolId,
        user_id: userId,
        requested_by: caller.id,
        role: role || "bursar",
        status: "pending",
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();
    if (requestError) {
      return json({ error: requestError.message }, 400);
    }

    return json({
      success: true,
      created: false,
      requestId: request.id,
      userId,
      message: "Request sent to user. They will be added once accepted.",
    });
  } catch (err) {
    console.error("Error in add-bursar:", err);
    return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});
