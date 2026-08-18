// promote-session
//
// Year-end rollover: move every student up a class into the next session, and
// graduate the ones at the top.
//
// Two modes, and the split is the point:
//
//   preview  works out what WOULD happen and returns it, changing nothing
//   commit   applies exactly that
//
// Standard SIS practice is that rollover is reviewed, not silent — a school
// with 400 students cannot eyeball a roster, so the exceptions have to be
// surfaced (leavers, unrecognised classes, students who owe). Preview is that
// review step.
//
// Promotion INSERTS enrolments for the next session and marks the old ones
// promoted/graduated. It never updates a class in place, so the ledger's
// history cannot be rewritten — which is the whole reason the enrolment table
// exists (migration 20260818120000).
//
// Students who owe money are promoted and FLAGGED, not blocked. Withholding
// promotion in the system does not collect the debt, and it strands the student
// outside the roster their school is actually teaching.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { highestClassInUse, promotionFor } from "../_shared/classes.ts";
import { requireSchoolOwner } from "../_shared/schoolAuth.ts";
import { feeNamesByIdFor, outstandingByStudent } from "../_shared/ledger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface Plan {
  student_id: string;
  student_code: string;
  name: string;
  from_class: string;
  action: "promote" | "graduate" | "unknown";
  to_class: string | null;
  reason: string;
  outstanding: number;
  already_enrolled: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { school_id, from_session_id, to_session_id, mode } = await req.json();

    if (!school_id || !from_session_id || !to_session_id) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (mode !== "preview" && mode !== "commit") {
      return json({ error: "mode must be 'preview' or 'commit'" }, 400);
    }
    if (from_session_id === to_session_id) {
      return json({ error: "Promote into a different session than the one you are promoting from." }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const auth = await requireSchoolOwner(supabaseAdmin, req, school_id);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    // Both sessions must be real rows belonging to this school. The dashboard
    // offers virtual "future-<year>" sessions that have no row; they are not
    // UUIDs and would 22P02 every query below.
    const { data: sessions } = await supabaseAdmin
      .from("sessions")
      .select("id, name")
      .eq("school_id", school_id)
      .in("id", [from_session_id, to_session_id]);

    const fromSession = (sessions || []).find((s: { id: string }) => s.id === from_session_id);
    const toSession = (sessions || []).find((s: { id: string }) => s.id === to_session_id);
    if (!fromSession || !toSession) {
      return json(
        { error: "Both sessions must already exist for this school. Create the new session first." },
        400
      );
    }

    // --- Who is being promoted ------------------------------------------------
    const { data: enrolments } = await supabaseAdmin
      .from("student_enrolments")
      .select("student_id, class, status")
      .eq("school_id", school_id)
      .eq("session_id", from_session_id)
      .eq("status", "active");

    if (!enrolments || enrolments.length === 0) {
      return json({ error: "No active students are enrolled in that session." }, 400);
    }

    const studentIds = enrolments.map((e: { student_id: string }) => e.student_id);

    const { data: students } = await supabaseAdmin
      .from("students")
      .select("id, student_id, name, status")
      .in("id", studentIds);
    const studentById = new Map(
      (students || []).map((s: { id: string }) => [s.id, s])
    );

    // Already enrolled next session? Rollover must be safe to run twice.
    const { data: existingNext } = await supabaseAdmin
      .from("student_enrolments")
      .select("student_id")
      .eq("school_id", school_id)
      .eq("session_id", to_session_id);
    const alreadyEnrolled = new Set(
      (existingNext || []).map((e: { student_id: string }) => e.student_id)
    );

    // --- What each of them owes, so the exception report can show it ----------
    const { data: charges } = await supabaseAdmin
      .from("student_charges")
      .select("student_id, class_fee_id, amount")
      .eq("school_id", school_id)
      .in("student_id", studentIds);

    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("student_id, items, status")
      .eq("school_id", school_id)
      .in("student_id", studentIds);

    // Fee NAMES are required, not optional: legacy payment lines carry no fee
    // id and match by name, so a blank name reads every one of them as unpaid.
    const nameById = await feeNamesByIdFor(
      supabaseAdmin,
      (charges || []).map((c: { class_fee_id: string }) => c.class_fee_id)
    );
    const outstandingMap = outstandingByStudent(
      (charges || []) as never,
      (payments || []) as never,
      nameById
    );

    // The school's own top class decides who graduates — a primary-only school's
    // leavers are in Primary 6, not SSS3.
    const ceiling = highestClassInUse(
      enrolments.map((e: { class: string }) => e.class)
    );

    const plans: Plan[] = enrolments.map((e: { student_id: string; class: string }) => {
      const s = studentById.get(e.student_id) as
        | { student_id: string; name: string }
        | undefined;
      const outcome = promotionFor(e.class, ceiling);
      return {
        student_id: e.student_id,
        student_code: s?.student_id ?? "?",
        name: s?.name ?? "(unknown)",
        from_class: e.class,
        action: outcome.action,
        to_class: outcome.nextClass,
        reason: outcome.reason,
        outstanding: outstandingMap.get(e.student_id) || 0,
        already_enrolled: alreadyEnrolled.has(e.student_id),
      };
    });

    const summary = {
      from_session: fromSession.name,
      to_session: toSession.name,
      highest_class_in_use: ceiling,
      total: plans.length,
      promoting: plans.filter((p) => p.action === "promote" && !p.already_enrolled).length,
      graduating: plans.filter((p) => p.action === "graduate" && !p.already_enrolled).length,
      unknown_class: plans.filter((p) => p.action === "unknown").length,
      owing: plans.filter((p) => p.outstanding > 0).length,
      owing_total: plans.reduce((a, p) => a + p.outstanding, 0),
      already_done: plans.filter((p) => p.already_enrolled).length,
    };

    if (mode === "preview") {
      return json({ mode: "preview", summary, plans });
    }

    // --- Commit ---------------------------------------------------------------
    // Insert next-session enrolments first. The charge trigger fires on each,
    // so students pick up any fees already published for the new session.
    const toInsert = plans
      .filter((p) => p.action === "promote" && p.to_class && !p.already_enrolled)
      .map((p) => ({
        school_id,
        student_id: p.student_id,
        session_id: to_session_id,
        class: p.to_class as string,
        status: "active",
      }));

    let enrolled = 0;
    if (toInsert.length > 0) {
      const { error } = await supabaseAdmin
        .from("student_enrolments")
        .upsert(toInsert, { onConflict: "student_id,session_id", ignoreDuplicates: true });
      if (error) {
        console.error("promote-session insert failed:", error.message);
        return json({ error: "Could not enrol students into the new session." }, 500);
      }
      enrolled = toInsert.length;
    }

    // Then close the old enrolments. Done second so a failure above leaves the
    // old session untouched and the whole thing can simply be re-run.
    const promotedIds = plans
      .filter((p) => p.action === "promote" && p.to_class)
      .map((p) => p.student_id);
    const graduatedIds = plans
      .filter((p) => p.action === "graduate")
      .map((p) => p.student_id);

    if (promotedIds.length > 0) {
      await supabaseAdmin
        .from("student_enrolments")
        .update({ status: "promoted" })
        .eq("school_id", school_id)
        .eq("session_id", from_session_id)
        .in("student_id", promotedIds);
    }
    if (graduatedIds.length > 0) {
      await supabaseAdmin
        .from("student_enrolments")
        .update({ status: "graduated" })
        .eq("school_id", school_id)
        .eq("session_id", from_session_id)
        .in("student_id", graduatedIds);
    }

    // students.class is the denormalised "current class" the admin roster
    // renders. Without this the roster still shows last year's classes after a
    // rollover, which reads as the promotion having silently failed.
    for (const p of plans) {
      if (p.action === "promote" && p.to_class && !p.already_enrolled) {
        await supabaseAdmin
          .from("students")
          .update({ class: p.to_class })
          .eq("id", p.student_id);
      }
    }

    // The school is now operating in the new session, so move is_current with
    // it. current_session_for_school() reads this, and leaving it behind would
    // enrol every newly added student into the year that just ended.
    await supabaseAdmin
      .from("sessions")
      .update({ is_current: false })
      .eq("school_id", school_id)
      .eq("is_current", true);
    await supabaseAdmin
      .from("sessions")
      .update({ is_current: true })
      .eq("id", to_session_id);

    // Students with an unrecognised class are left ACTIVE in the old session on
    // purpose: nobody decided what should happen to them, so they stay put and
    // keep showing up in the next preview rather than disappearing.
    //
    // Graduates keep their students row and stay on the roster; their enrolment
    // is marked graduated and they raise no new charges. Archiving a person is
    // the school's call, not a side effect of rollover.
    return json({
      mode: "commit",
      summary,
      applied: {
        enrolled_next_session: enrolled,
        marked_promoted: promotedIds.length,
        marked_graduated: graduatedIds.length,
        left_alone_unknown_class: summary.unknown_class,
      },
    });
  } catch (error) {
    console.error("Error in promote-session:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
