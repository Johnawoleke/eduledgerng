// create-payment
//
// Gateway-agnostic checkout. Replaces create-paystack-payment: the provider is
// chosen by selectGateway() in _shared/gatewayMoney.ts (Squad today), the
// adapter in _shared/gateways.ts talks to it, and the chosen gateway is written
// onto the payments row so verify and the webhooks route back correctly.
//
// The money model is unchanged. The school receives the EXACT fee it set; the
// platform fee and the gateway's charge are added on top and borne by the
// parent. Every guard from the Paystack-only version is preserved:
//   - authorised by the student's session token, never a password
//   - only PUBLISHED fees are payable
//   - fee ids are deduplicated before pricing
//   - amounts are matched by fee id, so same-named fees cannot cross-credit
//   - expected_total_kobo goes in metadata so recording can refuse an underpay
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encodeFeeItem, sumPaidForFee } from "../_shared/feeItems.ts";
import {
  PLATFORM_FEE_RATE, selectGateway, quoteCheckout,
} from "../_shared/gatewayMoney.ts";
import { gatewayFor, settlementKey, resolveBankCode } from "../_shared/gateways.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { school_slug, session_token, fee_payments, session_id, term_id, callback_url } =
      await req.json();

    if (!school_slug || !session_token || !fee_payments?.length) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (
      typeof session_token !== "string" || session_token.length > 200 ||
      typeof school_slug !== "string" || school_slug.length > 100 ||
      !Array.isArray(fee_payments) || fee_payments.length > 50
    ) {
      return json({ error: "Invalid input" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // --- School + student ---------------------------------------------------
    const { data: school } = await supabaseAdmin
      .from("schools")
      .select("id, name, slug, bank_name, account_number, account_name, settings")
      .eq("slug", school_slug)
      .maybeSingle();
    if (!school) return json({ error: "School not found" }, 404);

    const { data: students, error: verifyError } = await supabaseAdmin.rpc(
      "verify_student_session",
      { p_token: session_token }
    );
    if (verifyError || !students || students.length === 0) {
      return json({ error: "Your session has expired. Please log in again." }, 401);
    }
    const student = students[0];
    if (student.school_id !== school.id) {
      return json({ error: "Your session has expired. Please log in again." }, 401);
    }
    if (student.must_change_pin) {
      return json({ error: "Please set your own password before paying." }, 403);
    }

    // --- Validate against PUBLISHED fees ------------------------------------
    let feeQuery = supabaseAdmin
      .from("class_fees")
      .select("*")
      .eq("school_id", school.id)
      .eq("status", "published")
      .in("class_target", [student.class, "ALL"]);
    if (session_id) feeQuery = feeQuery.eq("session_id", session_id);
    if (term_id) feeQuery = feeQuery.eq("term_id", term_id);
    const { data: classFees } = await feeQuery;

    let paymentQuery = supabaseAdmin
      .from("payments")
      .select("items, status")
      .eq("student_id", student.id);
    if (session_id) paymentQuery = paymentQuery.eq("session_id", session_id);
    if (term_id) paymentQuery = paymentQuery.eq("term_id", term_id);
    const { data: existingPayments } = await paymentQuery;

    const settledPayments = (existingPayments || []).filter(
      (p: { status?: string | null }) => p.status !== "pending" && p.status !== "failed"
    );

    // Collapse by fee id first — sending the same id twice must not charge twice.
    const requestedByFee = new Map<string, number>();
    for (const fp of fee_payments) {
      const feeId = typeof fp?.fee_item_id === "string" ? fp.fee_item_id : null;
      const amount = Number(fp?.amount);
      if (!feeId || !Number.isFinite(amount) || amount <= 0) continue;
      requestedByFee.set(feeId, (requestedByFee.get(feeId) || 0) + amount);
    }

    let baseAmountNGN = 0;
    const validatedItems: { fee_item_id: string; amount: number; name: string }[] = [];
    for (const [feeId, requested] of requestedByFee) {
      const classFee = (classFees || []).find((cf: { id: string }) => cf.id === feeId);
      if (!classFee) continue;
      const totalPaid = Math.min(
        sumPaidForFee(settledPayments, { id: classFee.id, name: classFee.name }),
        Number(classFee.amount)
      );
      const payAmount = Math.min(requested, Number(classFee.amount) - totalPaid);
      if (payAmount <= 0) continue;
      baseAmountNGN += payAmount;
      validatedItems.push({ fee_item_id: classFee.id, amount: payAmount, name: classFee.name });
    }

    if (baseAmountNGN <= 0) return json({ error: "No valid payments" }, 400);

    const quote = quoteCheckout(baseAmountNGN, PLATFORM_FEE_RATE);
    if (quote.baseKobo < 100) return json({ error: "The minimum payment is ₦1." }, 400);

    const gatewayId = selectGateway(quote.baseKobo);
    const gateway = gatewayFor(gatewayId);
    if (!gateway.secret()) {
      console.error(`${gatewayId}: secret key not configured`);
      return json({ error: "Payment provider not configured" }, 500);
    }

    // --- Ensure the school has a settlement account at THIS gateway ---------
    const settings = (school.settings || {}) as Record<string, unknown>;
    const key = settlementKey(gatewayId);
    let settlementAccountId = settings[key] as string | undefined;

    if (!settlementAccountId) {
      if (!school.bank_name || !school.account_number) {
        return json(
          { error: "This school has not set up its bank account for receiving payments. Ask the school owner to add bank details in Settings." },
          400
        );
      }
      const bankCode = await resolveBankCode(gateway, school.bank_name);
      if (!bankCode) {
        return json(
          { error: `Could not match the school's bank ("${school.bank_name}") to a bank code. Ask the school owner to re-select their bank in Settings.` },
          400
        );
      }
      try {
        const created = await gateway.createSettlementAccount({
          schoolName: school.name,
          accountNumber: school.account_number,
          accountName: school.account_name || school.name,
          bankName: school.bank_name,
          bankCode,
        });
        settlementAccountId = created.id;
        await supabaseAdmin
          .from("schools")
          .update({ settings: { ...settings, [key]: created.id, ...(created.extra ?? {}) } })
          .eq("id", school.id);
      } catch (err) {
        console.error("settlement account creation failed:", err);
        return json(
          { error: err instanceof Error ? err.message : "Could not set up the school's settlement account." },
          502
        );
      }
    }

    // --- Initialize ---------------------------------------------------------
    const reference = `${gateway.refPrefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

    const { data: studentRecord } = await supabaseAdmin
      .from("students")
      .select("parent_email")
      .eq("id", student.id)
      .maybeSingle();
    const emailOk = (e: unknown): e is string =>
      typeof e === "string" && /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e) && !e.endsWith(".test");
    const customerEmail = emailOk(studentRecord?.parent_email)
      ? studentRecord!.parent_email!
      : `${String(student.student_id).replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "student"}@eduledgerng.ng`;

    let init;
    try {
      init = await gateway.initialize({
        reference,
        amountKobo: quote.totalKobo,
        platformFeeKobo: quote.platformKobo,
        email: customerEmail,
        customerName: String(student.name || student.student_id),
        callbackUrl:
          typeof callback_url === "string" && callback_url.length < 500 ? callback_url : undefined,
        settlementAccountId,
        metadata: {
          reference,
          gateway: gatewayId,
          school_id: school.id,
          school_slug,
          student_db_id: student.id,
          student_id: student.student_id,
          base_amount: baseAmountNGN,
          platform_fee: quote.platformKobo / 100,
          processing_fee: quote.processingFeeKobo / 100,
          total_ngn: quote.totalKobo / 100,
          expected_total_kobo: quote.totalKobo,
          session_id: session_id || null,
          term_id: term_id || null,
          items: validatedItems,
        },
      });
    } catch (err) {
      console.error(`${gatewayId} initialize failed:`, err);
      return json({ error: err instanceof Error ? err.message : "Failed to start payment" }, 502);
    }

    // Record the attempt as pending before redirecting. Best-effort: if this
    // fails the webhook still records the payment on success.
    const { error: pendingError } = await supabaseAdmin.from("payments").insert({
      school_id: school.id,
      student_id: student.id,
      amount: baseAmountNGN,
      amount_paid: 0,
      reference,
      method: gateway.id === "squad" ? "Squad" : "Paystack",
      gateway: gatewayId,
      status: "pending",
      items: validatedItems.map((i) => encodeFeeItem(i.fee_item_id, i.name, i.amount)),
      session_id: session_id || null,
      term_id: term_id || null,
    });
    if (pendingError) {
      console.error("create-payment: pending insert failed:", pendingError.message);
    }

    return json({
      authorization_url: init.checkoutUrl,
      gateway: gatewayId,
      reference,
      base_amount: baseAmountNGN,
      processing_fee: quote.processingFeeKobo / 100,
      total_ngn: quote.totalKobo / 100,
    });
  } catch (error) {
    console.error("Error in create-payment:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
