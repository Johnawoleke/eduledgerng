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
    const { schoolName, slug, address, phone, schoolEmail, email, password, fullName, schoolCode } = await req.json();

    if (!schoolName?.trim() || !slug?.trim() || !email?.trim() || !password?.trim()) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Check slug availability
    const { data: existing } = await supabaseAdmin
      .from("schools")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (existing) {
      return new Response(JSON.stringify({ error: "This school link is already taken" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create user with admin client (bypasses rate limiting), auto-confirm email
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (authError || !authData.user) {
      const msg = authError?.message || "Failed to create account";
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create school with service role (bypasses RLS)
    const { error: schoolError } = await supabaseAdmin.from("schools").insert({
      owner_id: authData.user.id,
      name: schoolName,
      slug,
      address: address || null,
      phone: phone || null,
      email: schoolEmail || null,
      school_code: schoolCode || slug.substring(0, 4).toUpperCase(),
    });

    if (schoolError) {
      // Cleanup: delete the created user
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return new Response(JSON.stringify({ error: "Failed to create school: " + schoolError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create profile
    await supabaseAdmin.from("profiles").insert({
      user_id: authData.user.id,
      full_name: fullName || null,
    });

    // Create school_admins entry
    const { data: schoolData } = await supabaseAdmin
      .from("schools")
      .select("id")
      .eq("slug", slug)
      .single();

    if (schoolData) {
      await supabaseAdmin.from("school_admins").insert({
        school_id: schoolData.id,
        user_id: authData.user.id,
      });
    }

    return new Response(JSON.stringify({ success: true, slug }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
