// set-student-class
//
// Corrects the class a student is enrolled in for one session. Until now a
// class could not be changed at all — it was set at creation and nothing in the
// app ever updated it, so a typo needed direct SQL.
//
// What changes is the ENROLMENT, not the student, so earlier sessions keep the
// class they actually had and their balances stay correct. That is the property
// the ledger exists to protect (migration 20260818120000).
//
// GUARD: refused once anything has been paid toward that session's fees.
// Swapping the charges would leave a real payment sitting against fees the
// student no longer owes — the money would vanish from every balance while
// still being in the bank. Correcting a typo before anyone pays is routine;
// rewriting billing history after money moved is not, and should not happen
// behind a dropdown.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { classRank } from "../_shared/classes.ts";
import { requireSchoolOwner } from "../_shared/schoolAuth.ts";
import { feeNamesByIdFor, paidForCharges } from "../_shared/ledger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const naira = (n: number) => `NGN ${Math.round(n).toLocaleString("en-NG")}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { school_id, student_id, session_id, new_class } = await req.json();

    if (!school_id || !student_id || !session_id || !new_class) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (typeof new_class !== "string" || classRank(new_class) < 0) {
      return json({ error: `"${new_class}" is not a class we recognise.` }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const auth = await requireSchoolOwner(supabaseAdmin, req, school_id);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    const { data: student } = await supabaseAdmin
      .from("students")
      .select("id, student_id, name, school_id, class")
      .eq("id", student_id)
      .maybeSingle();
    if (!student || student.school_id !== school_id) {
      return json({ error: "Student not found" }, 404);
    }

    const { data: enrolment } = await supabaseAdmin
      .from("student_enrolments")
      .select("id, class, status")
      .eq("student_id", student_id)
      .eq("session_id", session_id)
      .maybeSingle();

    if (enrolment && enrolment.class === new_class) {
      return json({ ok: true, unchanged: true, message: `Already in ${new_class}.` });
    }

    // --- The guard: has anything been paid for this session? -----------------
    const { data: charges } = await supabaseAdmin
      .from("student_charges")
      .select("id, class_fee_id, amount")
      .eq("student_id", student_id)
      .eq("session_id", session_id);

    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("items, status")
      .eq("student_id", student_id);

    // Fee NAMES matter here: a legacy payment line has no fee id and matches by
    // name, so passing a blank name would read a fully paid student as having
    // paid nothing and wave the change straight through.
    const nameById = await feeNamesByIdFor(
      supabaseAdmin,
      (charges || []).map((c: { class_fee_id: string }) => c.class_fee_id)
    );
    const paidTotal = paidForCharges(
      (charges || []) as never,
      (payments || []) as never,
      nameById
    );

    if (paidTotal > 0) {
      return json(
        {
          error:
            `${student.name} has already paid ${naira(paidTotal)} toward this session's fees. ` +
            `Changing their class would leave that payment against fees they no longer owe, ` +
            `so it has to be corrected deliberately rather than here.`,
          paid_total: paidTotal,
        },
        409
      );
    }

    // --- Safe to swap ---------------------------------------------------------
    // Nothing has been paid, so removing these charges cannot orphan money.
    if ((charges || []).length > 0) {
      const { error: delError } = await supabaseAdmin
        .from("student_charges")
        .delete()
        .eq("student_id", student_id)
        .eq("session_id", session_id);
      if (delError) {
        console.error("set-student-class delete charges:", delError.message);
        return json({ error: "Could not update this student's fees." }, 500);
      }
    }

    if (enrolment) {
      const { error: updError } = await supabaseAdmin
        .from("student_enrolments")
        .update({ class: new_class })
        .eq("id", enrolment.id);
      if (updError) {
        console.error("set-student-class update enrolment:", updError.message);
        return json({ error: "Could not update this student's class." }, 500);
      }
    } else {
      // No enrolment for that session yet — create one. Its insert trigger
      // raises the charges, so the rpc below is a no-op in this branch.
      const { error: insError } = await supabaseAdmin
        .from("student_enrolments")
        .insert({ school_id, student_id, session_id, class: new_class, status: "active" });
      if (insError) {
        console.error("set-student-class insert enrolment:", insError.message);
        return json({ error: "Could not enrol this student." }, 500);
      }
    }

    // The charge trigger fires on enrolment INSERT, not UPDATE, so an edited
    // enrolment has to ask for its charges explicitly. Idempotent.
    const { error: rpcError } = await supabaseAdmin.rpc("issue_charges_for_enrolment", {
      p_school_id: school_id,
      p_student_id: student_id,
      p_session_id: session_id,
      p_class: new_class,
    });
    if (rpcError) {
      console.error("issue_charges_for_enrolment:", rpcError.message);
      return json({ error: "Class changed, but the new fees could not be raised." }, 500);
    }

    // students.class is the denormalised "current class" the roster renders.
    // Keep it in step only when the edited session IS the current one.
    const { data: currentSessionId } = await supabaseAdmin.rpc("current_session_for_school", {
      p_school_id: school_id,
    });
    if (currentSessionId === session_id) {
      await supabaseAdmin.from("students").update({ class: new_class }).eq("id", student_id);
    }

    const { data: newCharges } = await supabaseAdmin
      .from("student_charges")
      .select("id")
      .eq("student_id", student_id)
      .eq("session_id", session_id);

    return json({
      ok: true,
      from_class: enrolment?.class ?? null,
      to_class: new_class,
      charges_replaced: (charges || []).length,
      charges_now: (newCharges || []).length,
    });
  } catch (error) {
    console.error("Error in set-student-class:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
