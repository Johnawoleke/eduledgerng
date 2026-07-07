// remove-bursar
//
// Off-boards a member from a school. Only a school OWNER may call it, and an
// owner cannot remove themselves (a school must keep an owner). Also signs the
// removed user out so their existing session token stops working immediately.
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
    const { schoolId, userId } = await req.json();
    if (!schoolId || !userId) {
      return json({ error: "Missing required fields" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify the caller is an owner of this school.
    const authHeader = req.headers.get("Authorization") || "";
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: callerData } = await callerClient.auth.getUser();
    const caller = callerData?.user;
    if (!caller) return json({ error: "You must be signed in" }, 401);

    const { data: school } = await supabaseAdmin
      .from("schools")
      .select("id, owner_id")
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
    if (!isOwner) return json({ error: "Only school owners can remove staff" }, 403);

    // Never remove an owner (protects against removing the last owner / self).
    if (userId === caller.id || school.owner_id === userId) {
      return json({ error: "You cannot remove an owner" }, 400);
    }
    const { data: targetRow } = await supabaseAdmin
      .from("school_admins")
      .select("id, role")
      .eq("school_id", schoolId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!targetRow) return json({ error: "That user is not a member of this school" }, 404);
    if (targetRow.role === "owner") {
      return json({ error: "You cannot remove an owner" }, 400);
    }

    const { error: delError } = await supabaseAdmin
      .from("school_admins")
      .delete()
      .eq("id", targetRow.id);
    if (delError) return json({ error: delError.message }, 400);

    // Best-effort: revoke the removed user's existing sessions so their current
    // JWT can't keep making requests until it expires.
    try {
      await supabaseAdmin.auth.admin.signOut(userId, "global");
    } catch (_) { /* signOut is best-effort */ }

    return json({ success: true });
  } catch (err) {
    console.error("Error in remove-bursar:", err);
    return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});
