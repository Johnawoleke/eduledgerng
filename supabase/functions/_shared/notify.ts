// Shared notification helper for the payment edge functions.
//
// Called by BOTH paystack-webhook and verify-paystack-payment at the moment a
// payment becomes success. Those two can race (either may flip a pending row to
// success), so this must be exactly-once per payment:
//   1. Insert one notifications row, keyed on `reference`. The partial unique
//      index (see 20260729120000_payment_notifications.sql) makes the second
//      caller's insert fail with 23505 — that caller then does nothing (no
//      duplicate realtime event, no duplicate email).
//   2. Only the caller that actually inserted emails the school owner (Resend).
//
// This never throws: a notification failure must not break payment recording.
// Callers should still wrap the call, but we defend in depth here.

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface PaymentNotifyInput {
  schoolId: string;
  reference: string;
  amountNGN: number;
  studentDbId?: string | null;
}

// Student and school names are attacker-influenced free text (a school owner
// types them, and a CSV upload can carry anything). They are interpolated into
// an HTML email that arrives from our domain, so they must be escaped or a
// crafted name can inject markup — a convincing phishing vector.
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const nairaFmt = (amount: number): string => {
  try {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `NGN ${Math.round(amount).toLocaleString()}`;
  }
};

// Look up the owner's email for a school: prefer schools.owner_id, fall back to
// the school_admins row with role 'owner'. Returns null if none is resolvable.
async function getOwnerEmail(admin: Admin, schoolId: string): Promise<string | null> {
  const { data: school } = await admin
    .from("schools")
    .select("owner_id")
    .eq("id", schoolId)
    .maybeSingle();

  let ownerId: string | null = school?.owner_id ?? null;
  if (!ownerId) {
    const { data: adminRow } = await admin
      .from("school_admins")
      .select("user_id")
      .eq("school_id", schoolId)
      .eq("role", "owner")
      .limit(1)
      .maybeSingle();
    ownerId = adminRow?.user_id ?? null;
  }
  if (!ownerId) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("email")
    .eq("id", ownerId)
    .maybeSingle();
  return profile?.email ?? null;
}

async function sendOwnerEmail(
  apiKey: string,
  to: string,
  schoolName: string,
  studentName: string | null,
  amountNGN: number,
): Promise<void> {
  const amount = nairaFmt(amountNGN);
  const who = studentName ? `<strong>${escapeHtml(studentName)}</strong>` : "A student";
  const safeSchool = escapeHtml(schoolName);
  const from = Deno.env.get("NOTIFY_FROM_EMAIL") || "EduLedgerNG <onboarding@resend.dev>";

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#111">
      <h2 style="color:#0A5C30;margin:0 0 8px">Payment received</h2>
      <p style="font-size:15px;line-height:1.5;margin:0 0 4px">
        ${who} just paid <strong>${amount}</strong> in fees at
        <strong>${safeSchool}</strong>.
      </p>
      <p style="font-size:13px;color:#555;line-height:1.5;margin:16px 0 0">
        This amount has been settled to your school's bank account (less the
        platform fee). Log in to your dashboard to see the full breakdown.
      </p>
    </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Payment received — ${amount} at ${schoolName}`,
      html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Resend email failed:", res.status, detail);
  }
}

export async function notifyPaymentReceived(
  admin: Admin,
  { schoolId, reference, amountNGN, studentDbId }: PaymentNotifyInput,
): Promise<void> {
  try {
    if (!schoolId || !reference || !(amountNGN > 0)) return;

    // School + student names for a readable message.
    const [{ data: school }, studentRes] = await Promise.all([
      admin.from("schools").select("name").eq("id", schoolId).maybeSingle(),
      studentDbId
        ? admin.from("students").select("name, class").eq("id", studentDbId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const schoolName: string = school?.name ?? "your school";
    const studentName: string | null = studentRes?.data?.name ?? null;
    const studentClass: string | null = studentRes?.data?.class ?? null;

    const title = "Payment received";
    const body = `${studentName ?? "A student"}${
      studentClass ? ` (${studentClass})` : ""
    } paid ${nairaFmt(amountNGN)}.`;

    // Idempotent insert. If another caller (webhook vs verify) already inserted
    // this reference, the unique index rejects us with 23505 and we stop here —
    // no duplicate realtime event, no duplicate email.
    const { error: insertErr } = await admin.from("notifications").insert({
      school_id: schoolId,
      type: "payment",
      title,
      body,
      reference,
      amount: amountNGN,
      metadata: { student_name: studentName, student_class: studentClass },
    });
    if (insertErr) {
      if (insertErr.code === "23505") return; // already notified — the other caller won
      console.error("notify insert failed:", insertErr.message);
      return;
    }

    // We won the insert — send the owner email (best effort).
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return; // in-app notification still delivered; email opt-in
    const ownerEmail = await getOwnerEmail(admin, schoolId);
    if (ownerEmail) {
      await sendOwnerEmail(resendKey, ownerEmail, schoolName, studentName, amountNGN);
    }
  } catch (err) {
    console.error("notifyPaymentReceived error:", err);
  }
}
