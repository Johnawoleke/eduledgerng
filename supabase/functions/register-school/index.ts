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
    const buildInitialSession = () => {
      const startYear = new Date().getFullYear();
      const endYear = startYear + 1;
      return {
        name: `${startYear}/${endYear}`,
        startYear,
        endYear,
      };
    };

    const { schoolName, slug, address, phone, schoolEmail, email, password, fullName, schoolCode, bankName, accountNumber, accountName } = await req.json();

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
      bank_name: bankName || null,
      account_number: accountNumber || null,
      account_name: accountName || null,
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

      // Fallback initializer in case DB trigger is missing/disabled.
      const { data: existingSessions } = await supabaseAdmin
        .from("sessions")
        .select("id")
        .eq("school_id", schoolData.id)
        .limit(1);

      if (!existingSessions || existingSessions.length === 0) {
        const initial = buildInitialSession();
        const { data: firstSession } = await supabaseAdmin
          .from("sessions")
          .insert({
            school_id: schoolData.id,
            name: initial.name,
            start_year: initial.startYear,
            end_year: initial.endYear,
            is_current: true,
          })
          .select("id")
          .single();

        if (firstSession?.id) {
          await supabaseAdmin.from("terms").insert([
            { session_id: firstSession.id, school_id: schoolData.id, name: "Term 1", term_number: 1, is_current: true },
            { session_id: firstSession.id, school_id: schoolData.id, name: "Term 2", term_number: 2, is_current: false },
            { session_id: firstSession.id, school_id: schoolData.id, name: "Term 3", term_number: 3, is_current: false },
          ]);
        }
      }
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
