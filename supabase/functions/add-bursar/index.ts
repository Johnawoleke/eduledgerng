// supabase/functions/add-bursar/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, schoolId, role, requestedById } = await req.json();

    if (!email || !schoolId || !role || !requestedById) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Find user by email (listUsers is paginated — default 50/page)
    const target = String(email).toLowerCase();
    let existingUser = null;
    for (let page = 1; page <= 20 && !existingUser; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      existingUser = data.users.find((u) => u.email?.toLowerCase() === target) || null;
      if (data.users.length < 1000) break;
    }

    if (!existingUser) {
      return new Response(
        JSON.stringify({ error: "User not found. Please sign up first." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = existingUser.id;

    // 2. Check if already a member
    const { data: existingMember } = await supabaseAdmin
      .from("school_admins")
      .select("id")
      .eq("school_id", schoolId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingMember) {
      return new Response(
        JSON.stringify({ error: "User is already a member of this school" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Check if there's already a pending request
    const { data: existingRequest } = await supabaseAdmin
      .from("school_requests")
      .select("id, status")
      .eq("school_id", schoolId)
      .eq("user_id", userId)
      .eq("status", "pending")
      .maybeSingle();

    if (existingRequest) {
      return new Response(
        JSON.stringify({ error: "A pending request already exists for this user" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Create the request
    const { data: request, error: requestError } = await supabaseAdmin
      .from("school_requests")
      .insert({
        school_id: schoolId,
        user_id: userId,
        requested_by: requestedById,
        role: role || "bursar",
        status: "pending",
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (requestError) {
      return new Response(
        JSON.stringify({ error: requestError.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        requestId: request.id,
        userId,
        message: "Request sent to user. They will be added once accepted."
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error in add-bursar:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});