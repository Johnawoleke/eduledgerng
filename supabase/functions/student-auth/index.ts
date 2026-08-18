// student-auth
//
// Two modes:
//   login   { school_slug, student_id, pin }   -> verifies the credential and
//                                                 mints an opaque session token
//   refresh { school_slug, session_token }     -> re-reads balances for an
//                                                 existing session
//
// The password is only ever sent on login. Everything afterwards (refresh,
// change-pin, checkout) carries the token, so the browser no longer has to keep
// the student's password around to stay logged in.
//
// Three hardening rules live here and must not be relaxed:
//   1. Credential logins are throttled per IP before any lookup, so student IDs
//      can't be enumerated at line speed.
//   2. A student who still has must_change_pin gets NO data and NO token — the
//      old build enforced that only in the React router, so calling this
//      function directly walked straight past it.
//   3. Balances come from the student_charges ledger, which only ever holds
//      charges raised from PUBLISHED fees.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sumPaidForFee } from "../_shared/feeItems.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

const SESSION_TTL_HOURS = 12;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { school_slug, student_id, pin, session_token, session_id, term_id } = await req.json();

    if (!school_slug || typeof school_slug !== "string" || school_slug.length > 100) {
      return json({ error: "Missing required fields" }, 400);
    }

    const isRefresh = typeof session_token === "string" && session_token.length > 0;

    if (!isRefresh) {
      if (!student_id || !pin) {
        return json({ error: "Missing required fields" }, 400);
      }
      // PIN max must match what the setters allow (student-set-pin caps at 50),
      // otherwise a student who chose a >10-char password is locked out at login.
      if (
        typeof student_id !== "string" || student_id.length > 30 ||
        typeof pin !== "string" || pin.length > 50
      ) {
        return json({ error: "Invalid input" }, 400);
      }
    } else if (session_token.length > 200) {
      return json({ error: "Invalid input" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const ip = clientIp(req);

    // --- Throttle credential attempts BEFORE touching the students table ------
    if (!isRefresh) {
      const { data: allowed, error: throttleError } = await supabaseAdmin.rpc(
        "student_auth_throttle_check",
        { p_ip: ip }
      );
      // Fail closed: if the throttle itself is broken we would rather reject
      // logins than serve an unmetered brute-force oracle.
      if (throttleError) {
        console.error("throttle check failed:", throttleError.message);
        return json({ error: "Service temporarily unavailable. Please try again." }, 503);
      }
      if (allowed === false) {
        return json(
          { error: "Too many login attempts. Please wait 15 minutes and try again." },
          429
        );
      }
    }

    // --- Resolve the school ---------------------------------------------------
    const { data: school, error: schoolError } = await supabaseAdmin
      .from("schools")
      .select("id, name")
      .eq("slug", school_slug)
      .maybeSingle();

    if (schoolError) {
      console.error("student-auth school lookup:", schoolError.message);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
    if (!school) {
      return json({ error: "School not found" }, 404);
    }

    // --- Authenticate ---------------------------------------------------------
    let student: Record<string, unknown> | null = null;

    if (isRefresh) {
      const { data: rows, error } = await supabaseAdmin.rpc("verify_student_session", {
        p_token: session_token,
      });
      if (error) {
        console.error("verify_student_session:", error.message);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
      if (!rows || rows.length === 0) {
        return json({ error: "Your session has expired. Please log in again." }, 401);
      }
      student = rows[0];
      // A token is bound to one school; never let it read another tenant.
      if (student.school_id !== school.id) {
        return json({ error: "Your session has expired. Please log in again." }, 401);
      }
    } else {
      const { data: rows, error } = await supabaseAdmin.rpc("verify_student_pin", {
        p_school_id: school.id,
        p_student_id: student_id,
        p_pin: pin,
      });
      if (error) {
        console.error("verify_student_pin:", error.message);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
      if (!rows || rows.length === 0) {
        return json({ error: "Invalid Student ID or password" }, 401);
      }
      student = rows[0];
    }

    // --- First login: no data, no session, until the password is replaced -----
    if (student.must_change_pin) {
      return json({
        must_change_pin: true,
        student: { student_id: student.student_id },
      });
    }

    // --- Mint a session on successful credential login ------------------------
    let sessionToken: string | undefined;
    let sessionExpiresAt: string | undefined;
    if (!isRefresh) {
      sessionToken = newSessionToken();
      const { data: expiresAt, error: sessionError } = await supabaseAdmin.rpc(
        "create_student_session",
        {
          p_student_id: student.id,
          p_school_id: school.id,
          p_token: sessionToken,
          p_ttl_hours: SESSION_TTL_HOURS,
        }
      );
      if (sessionError) {
        console.error("create_student_session:", sessionError.message);
        return json({ error: "Could not start your session. Please try again." }, 500);
      }
      sessionExpiresAt = expiresAt as string;
      await supabaseAdmin.rpc("student_auth_throttle_reset", { p_ip: ip });
    }

    // --- What this student was CHARGED (the ledger) + settled payments -------
    //
    // Read from student_charges, not from class_fees matched by the student's
    // current class. The old lookup recomputed the past on every read, so a
    // student promoted from JSS1 to JSS2 would have last year's balance
    // re-evaluated against JSS2's fee schedule. A charge is a row that was
    // written when the fee was published, and it never changes.
    //
    // Charges are generated by trigger (migration 20260818120000), so this
    // cannot drift from what the student actually owes.
    let feeQuery = supabaseAdmin
      .from("student_charges")
      .select("class_fee_id, amount, session_id, term_id")
      .eq("student_id", student.id);
    if (session_id) feeQuery = feeQuery.eq("session_id", session_id);
    if (term_id) feeQuery = feeQuery.eq("term_id", term_id);

    const { data: charges, error: feesError } = await feeQuery;
    if (feesError) {
      console.error("student-auth charges:", feesError.message);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }

    // The charge stores the class, not the fee's display name, so resolve names
    // in one go rather than joining per row.
    const chargeFeeIds = (charges || []).map((c: { class_fee_id: string }) => c.class_fee_id);
    const { data: feeNames } = chargeFeeIds.length
      ? await supabaseAdmin.from("class_fees").select("id, name").in("id", chargeFeeIds)
      : { data: [] as { id: string; name: string }[] };
    const nameById = new Map((feeNames || []).map((f: { id: string; name: string }) => [f.id, f.name]));

    const classFees = (charges || []).map(
      (c: { class_fee_id: string; amount: number; session_id: string | null; term_id: string | null }) => ({
        id: c.class_fee_id,
        name: nameById.get(c.class_fee_id) ?? "Fee",
        amount: Number(c.amount),
        session_id: c.session_id,
        term_id: c.term_id,
      })
    );

    // EVERY payment this student has made, deliberately unfiltered by period.
    //
    // A charge is credited by matching fee id, so a payment that settles an old
    // term's debt must count toward that charge no matter which period the row
    // is stamped with. Filtering this by the selected period is what let an
    // arrears payment appear to vanish.
    const { data: payments, error: paymentsError } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("student_id", student.id)
      .order("date", { ascending: false });
    if (paymentsError) {
      console.error("student-auth payments:", paymentsError.message);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }

    // Only settled payments count toward balances and appear in history. Pending
    // and failed Paystack attempts are recorded for the admin's visibility but
    // must not reduce a student's outstanding balance. Legacy rows have no
    // status column value -> treated as settled.
    const allSettledPayments = (payments || []).filter(
      (p: { status?: string | null }) => p.status !== "pending" && p.status !== "failed"
    );

    // Balances use every settled payment (above). The history list shown to the
    // student stays scoped to the period they are looking at.
    const settledPayments = allSettledPayments.filter(
      (p: { session_id?: string | null; term_id?: string | null }) =>
        (!session_id || p.session_id === session_id) &&
        (!term_id || p.term_id === term_id)
    );

    const feeItems = (classFees || []).map((cf: { id: string; name: string; amount: number; session_id: string | null; term_id: string | null }) => {
      const paid = Math.min(
        sumPaidForFee(allSettledPayments, { id: cf.id, name: cf.name }),
        Number(cf.amount)
      );
      return {
        id: cf.id,
        name: cf.name,
        amount: Number(cf.amount),
        paid,
        status: paid >= Number(cf.amount) ? "paid" : paid > 0 ? "partial" : "unpaid",
        session_id: cf.session_id || null,
        term_id: cf.term_id || null,
      };
    });

    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from("sessions")
      .select("id, name, start_year, end_year")
      .eq("school_id", school.id)
      .order("name", { ascending: true });
    if (sessionsError) {
      console.error("student-auth sessions:", sessionsError.message);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }

    const { data: terms, error: termsError } = await supabaseAdmin
      .from("terms")
      .select("id, session_id, name, term_number")
      .eq("school_id", school.id)
      .order("term_number", { ascending: true });
    if (termsError) {
      console.error("student-auth terms:", termsError.message);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }

    return json({
      student,
      school,
      feeItems,
      payments: settledPayments,
      sessions: sessions || [],
      terms: terms || [],
      ...(sessionToken ? { session_token: sessionToken, session_expires_at: sessionExpiresAt } : {}),
    });
  } catch (error) {
    console.error("Error in student-auth:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
