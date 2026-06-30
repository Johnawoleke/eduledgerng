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
    // Log the raw request body
    const rawBody = await req.clone().text();
    console.log("🔍 Raw request body:", rawBody);

    // Parse JSON
    const body = JSON.parse(rawBody);
    console.log("📦 Parsed body:", body);

    const buildInitialSession = () => {
      const startYear = new Date().getFullYear();
      const endYear = startYear + 1;
      return {
        name: `${startYear}/${endYear}`,
        startYear,
        endYear,
      };
    };

    // Accept both 'schoolName' and 'name'
    const schoolName = body.schoolName || body.name;
    const {
      slug,
      address,
      phone,
      schoolEmail,
      email,
      password,
      fullName,
      schoolCode,
      bankName,
      accountNumber,
      accountName,
      owner_id,
    } = body;

    // Log the extracted values
    console.log("📋 Extracted:", { schoolName, slug, schoolCode, owner_id });

    // Detailed validation with specific errors
    const missing = [];
    if (!schoolName?.trim()) missing.push("schoolName/name");
    if (!slug?.trim()) missing.push("slug");
    if (!schoolCode?.trim()) missing.push("schoolCode");

    if (missing.length > 0) {
      console.error("❌ Missing fields:", missing);
      return new Response(
        JSON.stringify({
          error: `Missing required fields: ${missing.join(", ")}`,
          received: { schoolName, slug, schoolCode, owner_id },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ... rest of your function (unchanged)
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
      return new Response(
        JSON.stringify({ error: "This school link is already taken" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let userId: string;

    if (owner_id) {
      userId = owner_id;
      const { data: userCheck, error: userCheckError } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (userCheckError || !userCheck.user) {
        return new Response(
          JSON.stringify({ error: "Owner user not found" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    } else {
      // New user flow
      if (!email?.trim() || !password?.trim() || !fullName?.trim()) {
        return new Response(
          JSON.stringify({ error: "Missing email, password, or fullName for new user" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      if (password.length < 6) {
        return new Response(
          JSON.stringify({ error: "Password must be at least 6 characters" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });

      if (authError || !authData.user) {
        const msg = authError?.message || "Failed to create account";
        return new Response(
          JSON.stringify({ error: msg }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      userId = authData.user.id;
      await supabaseAdmin.from("profiles").insert({
        user_id: userId,
        full_name: fullName || null,
      });
    }

    // --- Create school ---
    const { error: schoolError } = await supabaseAdmin.from("schools").insert({
      owner_id: userId,
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
      if (!owner_id) {
        await supabaseAdmin.auth.admin.deleteUser(userId);
      }
      return new Response(
        JSON.stringify({ error: "Failed to create school: " + schoolError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // --- Get school ID ---
    const { data: schoolData } = await supabaseAdmin
      .from("schools")
      .select("id")
      .eq("slug", slug)
      .single();

    if (schoolData) {
      await supabaseAdmin.from("school_admins").insert({
        school_id: schoolData.id,
        user_id: userId,
        role: "owner",
      });

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

    return new Response(
      JSON.stringify({ success: true, slug }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("🔥 Error in register-school:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error: " + err.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});