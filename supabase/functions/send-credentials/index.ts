// send-credentials
//
// Email each parent their child's login, so a school does not have to hand out
// 300 rows of a spreadsheet by hand.
//
// After a roster upload the credentials exist in exactly one place: a CSV of id
// and temporary password. Getting that to 300 parents was 300 manual acts, and
// it is the step where onboarding actually stalls. parent_email is already
// collected by the roster template and was, until now, used only as the
// Paystack customer address on receipts.
//
// RULES THIS MUST KEEP.
//
//   1. Only a pupil who still has a default_pin. That column is cleared the
//      moment the pupil sets their own password, so a pupil who has already
//      logged in is skipped — re-sending would mail a password that no longer
//      works and reveal nothing but noise.
//   2. Owner only. This reads every temporary password in the school.
//   3. Never fail the whole run for one bad address. A single bounced parent
//      must not stop the other 299 being told.
//
// The password is sent in clear, which is what a one-time credential IS. The
// mail says to change it on first login, and student-auth enforces that
// server-side by returning no data and no token until they do.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireSchoolOwner } from "../_shared/schoolAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Names and school names are free text a school owner typed or a CSV carried,
// interpolated into HTML sent from our domain. Unescaped, a crafted name is a
// convincing phishing vector — the same reasoning as _shared/notify.ts.
const escapeHtml = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { school_id, student_ids, portal_url } = await req.json();
    if (!school_id) return json({ error: "Missing required fields" }, 400);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const auth = await requireSchoolOwner(supabaseAdmin, req, school_id);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      return json(
        { error: "Email is not configured for this system yet. Use the printable slips instead." },
        503
      );
    }

    const { data: school } = await supabaseAdmin
      .from("schools").select("name, slug").eq("id", school_id).maybeSingle();

    let q = supabaseAdmin
      .from("students")
      .select("id, student_id, name, class, parent_email, default_pin")
      .eq("school_id", school_id)
      .not("default_pin", "is", null)
      .neq("status", "archived");
    // Narrow to one upload's worth when the caller says which; otherwise every
    // pupil who has not yet logged in.
    if (Array.isArray(student_ids) && student_ids.length > 0) {
      q = q.in("id", student_ids.slice(0, 2000));
    }
    const { data: students, error } = await q;
    if (error) {
      console.error("send-credentials read failed:", error.message);
      return json({ error: "Could not read the student list." }, 500);
    }

    const schoolName = school?.name || "your school";
    const portal = typeof portal_url === "string" && /^https?:\/\//.test(portal_url)
      ? portal_url
      : `https://www.eduledgerng.com/school/${school?.slug || ""}`;
    const from = Deno.env.get("NOTIFY_FROM_EMAIL") || "EduLedgerNG <onboarding@resend.dev>";

    let sent = 0;
    const noEmail: string[] = [];
    const failed: string[] = [];

    for (const s of students || []) {
      const to = String(s.parent_email || "").trim();
      if (!EMAIL_RE.test(to)) { noEmail.push(s.student_id); continue; }

      const html = `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#111">
          <h2 style="color:#0A5C30;margin:0 0 8px">${escapeHtml(schoolName)}</h2>
          <p style="font-size:15px;line-height:1.5;margin:0 0 16px">
            Here are the login details for <strong>${escapeHtml(String(s.name || ""))}</strong>
            (${escapeHtml(String(s.class || ""))}). You can use them to see school
            fees and pay online.
          </p>
          <table style="font-size:15px;line-height:1.8;margin:0 0 16px">
            <tr><td style="color:#555;padding-right:12px">Student ID</td>
                <td><strong style="font-family:monospace">${escapeHtml(String(s.student_id))}</strong></td></tr>
            <tr><td style="color:#555;padding-right:12px">First-time password</td>
                <td><strong style="font-family:monospace">${escapeHtml(String(s.default_pin))}</strong></td></tr>
          </table>
          <p style="font-size:15px;margin:0 0 16px">
            <a href="${escapeHtml(portal)}" style="background:#0A5C30;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Log in</a>
          </p>
          <p style="font-size:13px;color:#555;line-height:1.5;margin:0">
            You will be asked to choose your own password the first time you log
            in. Please keep these details private.
          </p>
        </div>`;

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from, to: [to],
            subject: `${schoolName}: login details for ${s.name}`,
            html,
          }),
        });
        // One rejected address must never stop the rest of the school being
        // told, so this is counted and carried on from, not thrown.
        if (res.ok) sent += 1;
        else {
          failed.push(String(s.student_id));
          console.error("Resend rejected", s.student_id, res.status, await res.text().catch(() => ""));
        }
      } catch (err) {
        failed.push(String(s.student_id));
        console.error("Resend threw for", s.student_id, err);
      }
    }

    return json({
      sent,
      // The school has to know who was NOT reached, or it believes every parent
      // has their login and stops chasing.
      no_email: noEmail.length,
      failed: failed.length,
      no_email_student_ids: noEmail.slice(0, 200),
      failed_student_ids: failed.slice(0, 200),
    });
  } catch (error) {
    console.error("Error in send-credentials:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
