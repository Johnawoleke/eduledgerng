// register-school
//
// Creates a school (a "branch") owned by the CALLER, and seeds its first
// academic session + terms.
//
// This function used to run with verify_jwt = false and take `owner_id` from
// the request body, so anyone on the internet could create unlimited auth
// accounts and schools, or attach a school — with attacker-chosen bank details
// — to somebody else's account. The owner is now taken from the caller's
// verified JWT and the body value is ignored.
//
// The old "create the user too" branch is gone. Account creation happens at
// /register via supabase.auth.signUp; RegisterSchool.tsx has always required a
// signed-in user before calling this, so nothing legitimate used that path.
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

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "login", "register", "register-school", "school",
  "settings", "student", "dashboard", "main-dashboard", "calculator",
  "account-recovery", "change-password", "reset-password", "receipt",
]);

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Never log the body.
    const body = await req.json();

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // --- The caller IS the owner ---------------------------------------------
    // verify_jwt is on for this function, but the anon key is itself a valid
    // JWT, so the identity check has to happen here as well.
    const authHeader = req.headers.get("Authorization") || "";
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: callerData } = await callerClient.auth.getUser();
    const caller = callerData?.user;
    if (!caller) {
      return json({ error: "You must be signed in to register a school" }, 401);
    }
    const userId = caller.id;

    // A bursar still on the temporary password their owner issued must rotate it
    // before creating anything.
    const { data: callerProfile } = await supabaseAdmin
      .from("profiles")
      .select("must_change_password")
      .eq("id", userId)
      .maybeSingle();
    if (callerProfile?.must_change_password) {
      return json({ error: "Please change your temporary password first." }, 403);
    }

    // --- Validate -------------------------------------------------------------
    const schoolName = str(body.schoolName ?? body.name, 120);
    const slug = str(body.slug, 60)?.toLowerCase() ?? null;
    const schoolCode = str(body.schoolCode, 20);

    const missing: string[] = [];
    if (!schoolName) missing.push("schoolName/name");
    if (!slug) missing.push("slug");
    if (!schoolCode) missing.push("schoolCode");
    if (missing.length > 0) {
      return json({ error: `Missing required fields: ${missing.join(", ")}` }, 400);
    }

    if (!SLUG_RE.test(slug!) || RESERVED_SLUGS.has(slug!)) {
      return json({ error: "That school link isn't available. Please choose another." }, 400);
    }

    const accountNumber = body.accountNumber == null ? null : str(body.accountNumber, 10);
    if (body.accountNumber != null && (!accountNumber || !/^\d{10}$/.test(accountNumber))) {
      return json({ error: "Account number must be exactly 10 digits" }, 400);
    }

    // Cap how many schools one account can create, so a compromised or throwaway
    // login can't be used to flood the tenant list.
    const { count: ownedCount } = await supabaseAdmin
      .from("schools")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId);
    if ((ownedCount ?? 0) >= 25) {
      return json(
        { error: "You've reached the maximum number of schools for one account. Contact support to raise it." },
        403
      );
    }

    // --- Create ---------------------------------------------------------------
    const { data: existing } = await supabaseAdmin
      .from("schools")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (existing) {
      return json({ error: "This school link is already taken" }, 409);
    }

    const { data: schoolRow, error: schoolError } = await supabaseAdmin
      .from("schools")
      .insert({
        owner_id: userId,
        name: schoolName,
        slug,
        address: str(body.address, 250),
        phone: str(body.phone, 40),
        email: str(body.schoolEmail, 160),
        school_code: schoolCode || slug!.substring(0, 4).toUpperCase(),
      })
      .select("id")
      .single();

    if (schoolError || !schoolRow) {
      console.error("register-school insert:", schoolError?.message);
      return json({ error: "Failed to create school. Please try again." }, 500);
    }

    // Bank details go in school_settlement, never on schools: schools is
    // anon-readable so the portal can show a school's name before login, which
    // made every account number public (migration 20260823120000).
    //
    // A school with no bank details yet gets no row rather than an empty one —
    // "not set up" and "set up as blank" should not look the same to
    // create-payment.
    const bankName = str(body.bankName, 120);
    const accountName = str(body.accountName, 160);
    if (bankName || accountNumber || accountName) {
      const { error: settlementError } = await supabaseAdmin
        .from("school_settlement")
        .insert({
          school_id: schoolRow.id,
          bank_name: bankName,
          account_number: accountNumber,
          account_name: accountName,
        });
      // Not fatal. The school exists and is usable; the owner can add bank
      // details in Settings. Failing registration here would strand an account
      // that is already half-created.
      if (settlementError) {
        console.error("register-school settlement insert:", settlementError.message);
      }
    }

    await supabaseAdmin.from("school_admins").insert({
      school_id: schoolRow.id,
      user_id: userId,
      role: "owner",
    });

    const { data: existingSessions } = await supabaseAdmin
      .from("sessions")
      .select("id")
      .eq("school_id", schoolRow.id)
      .limit(1);

    if (!existingSessions || existingSessions.length === 0) {
      const startYear = new Date().getFullYear();
      const { data: firstSession } = await supabaseAdmin
        .from("sessions")
        .insert({
          school_id: schoolRow.id,
          name: `${startYear}/${startYear + 1}`,
          start_year: startYear,
          end_year: startYear + 1,
          is_current: true,
        })
        .select("id")
        .single();

      if (firstSession?.id) {
        await supabaseAdmin.from("terms").insert([
          { session_id: firstSession.id, school_id: schoolRow.id, name: "Term 1", term_number: 1, is_current: true },
          { session_id: firstSession.id, school_id: schoolRow.id, name: "Term 2", term_number: 2, is_current: false },
          { session_id: firstSession.id, school_id: schoolRow.id, name: "Term 3", term_number: 3, is_current: false },
        ]);
      }
    }

    return json({ success: true, slug });
  } catch (err) {
    console.error("Error in register-school:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
