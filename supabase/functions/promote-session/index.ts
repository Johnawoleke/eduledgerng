// promote-session
//
// Year-end rollover: decide what happens to every student at the end of a
// session, then apply it.
//
// Three modes:
//   preview  work out a DEFAULT outcome for each student; change nothing
//   commit   apply the decisions the school actually made
//   undo     reverse one committed rollover
//
// The split matters. Rollover is reviewed, not one click: a school with 400
// students cannot check a roster by eye, so preview surfaces the exceptions and
// the school edits what it disagrees with before anything is written.
//
// WHY THE DECISIONS COME FROM THE CALLER. The first build computed every
// outcome at commit time from the class ladder, which meant everyone moved up
// and nothing else was expressible. Real schools end a session with three
// outcomes — a Nigerian promotion exam promotes at 50%+, "promotes on trial" at
// 40-49%, and repeats below 40% — and mature systems store a per-student next
// grade that is defaulted and then overridden before the rollover runs. So
// preview proposes, the school disposes, and commit applies exactly what it is
// given rather than recomputing.
//
// Promotion INSERTS enrolments for the next session and stamps the outcome on
// the one being left. It never edits a class in place, so the ledger's history
// cannot be rewritten (migration 20260818120000).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  classRank, highestClassInUse, promotionFor, nextClass,
  OUTCOME_STATUS, type PromotionAction,
} from "../_shared/classes.ts";
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

interface Decision {
  student_id: string;
  action: PromotionAction;
  to_class?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { school_id, from_session_id, to_session_id, mode } = body;

    if (!school_id) return json({ error: "Missing required fields" }, 400);
    if (mode !== "preview" && mode !== "commit" && mode !== "undo") {
      return json({ error: "mode must be 'preview', 'commit' or 'undo'" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const auth = await requireSchoolOwner(supabaseAdmin, req, school_id);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    // ---------------------------------------------------------------------
    // UNDO — reverse one committed rollover
    // ---------------------------------------------------------------------
    if (mode === "undo") {
      const batch = body.rollover_batch;
      if (!batch) return json({ error: "Missing rollover_batch" }, 400);

      const { data: touched } = await supabaseAdmin
        .from("student_enrolments")
        .select("id, student_id, session_id, class, status")
        .eq("school_id", school_id)
        .eq("rollover_batch", batch);

      if (!touched || touched.length === 0) {
        return json({ error: "That rollover was not found, or has already been undone." }, 404);
      }

      // A rollover touches two kinds of row, both carrying the batch:
      //   created  — the new session's enrolments, left 'active'
      //   stamped  — the old session's enrolments, marked with the outcome
      // Undo deletes the first and puts the second back. Splitting on status
      // rather than on session means a graduate, who has no created row, is
      // still reversed.
      type Row = { id: string; student_id: string; session_id: string; class: string; status: string };
      const created = (touched as Row[]).filter((e) => e.status === "active");
      const stamped = (touched as Row[]).filter((e) => e.status !== "active");

      const studentIds = Array.from(new Set((touched as Row[]).map((e) => e.student_id)));
      const sessionIds = Array.from(new Set(created.map((e) => e.session_id)));

      // Refuse if money has landed against the new session's charges. Deleting
      // a paid charge would orphan a real payment — the same rule
      // set-student-class enforces.
      if (sessionIds.length > 0) {
        const { data: newCharges } = await supabaseAdmin
          .from("student_charges")
          .select("student_id, class_fee_id, amount")
          .in("student_id", studentIds)
          .in("session_id", sessionIds);

        const { data: pays } = await supabaseAdmin
          .from("payments")
          .select("student_id, items, status")
          .eq("school_id", school_id)
          .in("student_id", studentIds);

        const names = await feeNamesByIdFor(
          supabaseAdmin,
          (newCharges || []).map((c: { class_fee_id: string }) => c.class_fee_id)
        );
        const owed = outstandingByStudent((newCharges || []) as never, (pays || []) as never, names);
        const billed = new Map<string, number>();
        for (const c of newCharges || []) {
          const row = c as { student_id: string; amount: number };
          billed.set(row.student_id, (billed.get(row.student_id) || 0) + Number(row.amount));
        }
        const paidSomething = [...billed.entries()].filter(
          ([sid, total]) => total - (owed.get(sid) || 0) > 0
        );
        if (paidSomething.length > 0) {
          return json(
            {
              error:
                `${paidSomething.length} student(s) have already paid toward the new session. ` +
                `Undoing would leave those payments against fees they no longer owe, so this ` +
                `rollover can no longer be reversed automatically.`,
            },
            409
          );
        }

        // Charges first: student_charges has no FK to enrolments, so they would
        // otherwise be left billing students for a year they are not in.
        await supabaseAdmin
          .from("student_charges")
          .delete()
          .in("student_id", studentIds)
          .in("session_id", sessionIds);

        await supabaseAdmin
          .from("student_enrolments")
          .delete()
          .in("id", created.map((e) => e.id));
      }

      // Put the year they came from back, and the roster with it. Restoring
      // students.status is what un-graduates a leaver.
      for (const e of stamped) {
        await supabaseAdmin
          .from("student_enrolments")
          .update({ status: "active", rollover_batch: null })
          .eq("id", e.id);
        await supabaseAdmin
          .from("students")
          .update({ class: e.class, status: "active" })
          .eq("id", e.student_id);
      }

      return json({ mode: "undo", reversed: created.length, restored: stamped.length });
    }

    // ---------------------------------------------------------------------
    // preview / commit
    // ---------------------------------------------------------------------
    if (!from_session_id || !to_session_id) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (from_session_id === to_session_id) {
      return json({ error: "Promote into a different session than the one you are promoting from." }, 400);
    }

    const { data: school } = await supabaseAdmin
      .from("schools")
      .select("id, settings")
      .eq("id", school_id)
      .maybeSingle();

    // Both sessions must be real rows for this school. The picker also offers
    // virtual "future-<year>" sessions, which are not UUIDs.
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
      .select("id, student_id, name")
      .in("id", studentIds);
    const studentById = new Map((students || []).map((s: { id: string }) => [s.id, s]));

    const { data: existingNext } = await supabaseAdmin
      .from("student_enrolments")
      .select("student_id")
      .eq("school_id", school_id)
      .eq("session_id", to_session_id);
    const alreadyEnrolled = new Set(
      (existingNext || []).map((e: { student_id: string }) => e.student_id)
    );

    // --- The school's final class -------------------------------------------
    //
    // Declared by the school, NOT inferred from the roster. Inferring it breaks
    // in ordinary situations: a through school with no SSS3 students this year
    // would graduate its SSS2s, and a new school whose only intake is Primary 1
    // would graduate its entire roll on the first rollover. The roster is only
    // used to seed a suggestion the school then confirms.
    const settings = (school?.settings || {}) as Record<string, unknown>;
    const declaredFinal =
      typeof settings.final_class === "string" && classRank(settings.final_class) >= 0
        ? (settings.final_class as string)
        : null;
    const suggestedFinal = highestClassInUse(
      enrolments.map((e: { class: string }) => e.class)
    );
    const finalClass = declaredFinal ?? suggestedFinal;

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

    const nameById = await feeNamesByIdFor(
      supabaseAdmin,
      (charges || []).map((c: { class_fee_id: string }) => c.class_fee_id)
    );
    const outstandingMap = outstandingByStudent(
      (charges || []) as never,
      (payments || []) as never,
      nameById
    );

    const defaults = enrolments.map((e: { student_id: string; class: string }) => {
      const s = studentById.get(e.student_id) as { student_id: string; name: string } | undefined;
      const outcome = promotionFor(e.class, finalClass);
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

    if (mode === "preview") {
      return json({
        mode: "preview",
        from_session: fromSession.name,
        to_session: toSession.name,
        final_class: finalClass,
        final_class_is_declared: declaredFinal != null,
        suggested_final_class: suggestedFinal,
        plans: defaults,
      });
    }

    // --- commit --------------------------------------------------------------
    //
    // Apply the decisions given. Falls back to the computed defaults when none
    // are supplied, so an older client still works.
    const supplied: Decision[] = Array.isArray(body.decisions) ? body.decisions : [];
    const byStudent = new Map(supplied.map((d) => [d.student_id, d]));

    const enrolledClass = new Map(
      enrolments.map((e: { student_id: string; class: string }) => [e.student_id, e.class])
    );

    const applied: { student_id: string; action: PromotionAction; to_class: string | null }[] = [];
    for (const d of defaults) {
      const chosen = byStudent.get(d.student_id);
      let action: PromotionAction = chosen?.action ?? d.action;
      let toClass: string | null = chosen?.to_class ?? d.to_class;

      // Only decide for students actually enrolled in the session being left.
      if (!enrolledClass.has(d.student_id)) continue;

      if (action === "repeat") toClass = enrolledClass.get(d.student_id) ?? null;
      if (action === "graduate" || action === "unknown") toClass = null;
      if ((action === "promote" || action === "on_trial") && !toClass) {
        toClass = nextClass(enrolledClass.get(d.student_id));
      }
      // A class nobody recognises is not a placement. Leave the student where
      // they are rather than inventing one.
      if (toClass != null && classRank(toClass) < 0) {
        action = "unknown";
        toClass = null;
      }
      applied.push({ student_id: d.student_id, action, to_class: toClass });
    }

    const batch = crypto.randomUUID();

    const toInsert = applied
      .filter((a) => a.to_class && !alreadyEnrolled.has(a.student_id))
      .map((a) => ({
        school_id,
        student_id: a.student_id,
        session_id: to_session_id,
        class: a.to_class as string,
        status: "active",
        rollover_batch: batch,
      }));

    if (toInsert.length > 0) {
      const { error } = await supabaseAdmin
        .from("student_enrolments")
        .upsert(toInsert, { onConflict: "student_id,session_id", ignoreDuplicates: true });
      if (error) {
        console.error("promote-session insert failed:", error.message);
        return json({ error: "Could not enrol students into the new session." }, 500);
      }
    }

    // Stamp the outcome on the year being left, one status per outcome.
    const counts: Record<string, number> = {};
    for (const action of ["promote", "on_trial", "repeat", "graduate"] as const) {
      const ids = applied.filter((a) => a.action === action).map((a) => a.student_id);
      counts[action] = ids.length;
      if (ids.length === 0) continue;
      // The batch goes on the OUTGOING enrolment as well. Undo previously only
      // knew about enrolments it CREATED, so a graduate — who gets no new
      // enrolment — was never reversed and stayed marked as having left.
      await supabaseAdmin
        .from("student_enrolments")
        .update({ status: OUTCOME_STATUS[action], rollover_batch: batch })
        .eq("school_id", school_id)
        .eq("session_id", from_session_id)
        .in("student_id", ids);
    }

    // The roster renders students.class, so it has to follow the placement or
    // it still shows last year's classes.
    for (const a of applied) {
      if (a.to_class && !alreadyEnrolled.has(a.student_id)) {
        await supabaseAdmin.from("students").update({ class: a.to_class }).eq("id", a.student_id);
      }
    }

    // Leavers come off the active roster. Without this they sit in their old
    // class forever, indistinguishable from students still being taught.
    const graduatedIds = applied.filter((a) => a.action === "graduate").map((a) => a.student_id);
    if (graduatedIds.length > 0) {
      await supabaseAdmin.from("students").update({ status: "graduated" }).in("id", graduatedIds);
    }

    // is_current moves ONLY if asked. Rolling over in June must not declare a
    // year that has not started to be the school's current one.
    if (body.make_current === true) {
      await supabaseAdmin
        .from("sessions").update({ is_current: false })
        .eq("school_id", school_id).eq("is_current", true);
      await supabaseAdmin
        .from("sessions").update({ is_current: true }).eq("id", to_session_id);
    }

    return json({
      mode: "commit",
      rollover_batch: batch,
      from_session: fromSession.name,
      to_session: toSession.name,
      applied: {
        enrolled_next_session: toInsert.length,
        promoted: counts.promote || 0,
        on_trial: counts.on_trial || 0,
        repeated: counts.repeat || 0,
        graduated: counts.graduate || 0,
        left_alone_unknown_class: applied.filter((a) => a.action === "unknown").length,
      },
    });
  } catch (error) {
    console.error("Error in promote-session:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
