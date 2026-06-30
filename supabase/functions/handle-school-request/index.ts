// supabase/functions/handle-school-request/index.ts
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
    const { requestId, action } = await req.json();

    if (!requestId || !action) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!["accept", "decline"].includes(action)) {
      return new Response(
        JSON.stringify({ error: "Invalid action. Use 'accept' or 'decline'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Get the request
    const { data: request, error: requestError } = await supabaseAdmin
      .from("school_requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (requestError || !request) {
      return new Response(
        JSON.stringify({ error: "Request not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Check if expired
    if (new Date(request.expires_at) < new Date()) {
      await supabaseAdmin
        .from("school_requests")
        .update({ status: "expired" })
        .eq("id", requestId);
      return new Response(
        JSON.stringify({ error: "This request has expired" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. If accepting, add to school_admins
    if (action === "accept") {
      const { data: existingMember } = await supabaseAdmin
        .from("school_admins")
        .select("id")
        .eq("school_id", request.school_id)
        .eq("user_id", request.user_id)
        .maybeSingle();

      if (!existingMember) {
        const { error: insertError } = await supabaseAdmin
          .from("school_admins")
          .insert({
            school_id: request.school_id,
            user_id: request.user_id,
            role: request.role,
          });

        if (insertError) {
          return new Response(
            JSON.stringify({ error: insertError.message }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // 4. Update request status
    const { error: updateError } = await supabaseAdmin
      .from("school_requests")
      .update({ 
        status: action === "accept" ? "accepted" : "declined" 
      })
      .eq("id", requestId);

    if (updateError) {
      return new Response(
        JSON.stringify({ error: updateError.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        action,
        message: action === "accept" ? "Request accepted! You now have access to the school." : "Request declined."
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error in handle-school-request:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});