// create-paystack-payment
//
// Initializes a Paystack transaction for a student's selected fees using a
// split payment: the money settles into the school's own bank account via a
// per-school Paystack subaccount, while a flat `transaction_charge` (the 1%
// platform fee) stays with the platform's main Paystack account.
//
// Money model (all amounts in kobo internally):
//   base            = sum of validated fee payments (what counts toward fees)
//   platform_fee    = 1% of base                     -> platform main account
//   total charged   = gross-up(base) so that after Paystack deducts its own
//                     processing fee the settled amount still equals base.
//                     The student therefore bears the gateway fee.
//   school receives = base - platform_fee   (bearer: "subaccount")
//
// Requires the PAYSTACK_SECRET_KEY edge function secret.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const PLATFORM_FEE_RATE = 0.01;
const PAYSTACK_API = "https://api.paystack.co";

// Paystack NGN pricing: 1.5% + ₦100, the ₦100 waived under ₦2,500, capped at ₦2,000.
const paystackFeeKobo = (amountKobo: number): number => {
  let fee = 0.015 * amountKobo;
  if (amountKobo >= 250_000) fee += 10_000;
  return Math.min(Math.ceil(fee), 200_000);
};

// Smallest total T such that T - paystackFee(T) >= base.
const grossUpKobo = (baseKobo: number): number => {
  let total =
    baseKobo >= 246_250
      ? Math.ceil((baseKobo + 10_000) / 0.985)
      : Math.ceil(baseKobo / 0.985);
  if (0.015 * total + 10_000 > 200_000) total = baseKobo + 200_000;
  while (total - paystackFeeKobo(total) < baseKobo) total += 100;
  return total;
};

const normalizeBankName = (name: string) =>
  name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\b(bank|of|nigeria|plc|the)\b/g, "")
    .replace(/[^a-z]/g, "");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { school_slug, student_id, pin, fee_payments, session_id, term_id, callback_url } =
      await req.json();

    if (!school_slug || !student_id || !pin || !fee_payments?.length) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (
      typeof student_id !== "string" || student_id.length > 30 ||
      typeof pin !== "string" || pin.length > 50 ||
      typeof school_slug !== "string" || school_slug.length > 100
    ) {
      return json({ error: "Invalid input" }, 400);
    }

    const paystackKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackKey) {
      return json({ error: "Payment provider not configured" }, 500);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // --- School + student verification -------------------------------------
    const { data: school } = await supabaseAdmin
      .from("schools")
      .select("id, name, slug, bank_name, account_number, account_name, settings")
      .eq("slug", school_slug)
      .maybeSingle();

    if (!school) return json({ error: "School not found" }, 404);

    const { data: students, error: verifyError } = await supabaseAdmin.rpc("verify_student_pin", {
      p_school_id: school.id,
      p_student_id: student_id,
      p_pin: pin,
    });

    if (verifyError || !students || students.length === 0) {
      return json({ error: "Invalid credentials" }, 401);
    }
    const student = students[0];

    // --- Validate requested payments against class fees for the period -----
    let feeQuery = supabaseAdmin
      .from("class_fees")
      .select("*")
      .eq("school_id", school.id)
      .in("class_target", [student.class, "ALL"]);
    if (session_id) feeQuery = feeQuery.eq("session_id", session_id);
    if (term_id) feeQuery = feeQuery.eq("term_id", term_id);
    const { data: classFees } = await feeQuery;

    let paymentQuery = supabaseAdmin
      .from("payments")
      .select("items")
      .eq("student_id", student.id);
    if (session_id) paymentQuery = paymentQuery.eq("session_id", session_id);
    if (term_id) paymentQuery = paymentQuery.eq("term_id", term_id);
    const { data: existingPayments } = await paymentQuery;

    const paidMap: Record<string, number> = {};
    (existingPayments || []).forEach((p: { items: string[] | null }) => {
      (p.items || []).forEach((item: string) => {
        const pipeIdx = item.lastIndexOf("|");
        if (pipeIdx > 0) {
          const itemName = item.substring(0, pipeIdx);
          const itemAmount = Number(item.substring(pipeIdx + 1));
          if (!isNaN(itemAmount)) {
            paidMap[itemName] = (paidMap[itemName] || 0) + itemAmount;
          }
        }
      });
    });

    let baseAmountNGN = 0;
    const validatedItems: { fee_item_id: string; amount: number; name: string }[] = [];
    for (const fp of fee_payments) {
      const classFee = (classFees || []).find((cf: { id: string }) => cf.id === fp.fee_item_id);
      if (!classFee) continue;
      const totalPaid = Math.min(paidMap[classFee.name] || 0, Number(classFee.amount));
      const owing = Number(classFee.amount) - totalPaid;
      const payAmount = Math.min(Math.max(Number(fp.amount), 0), owing);
      if (payAmount <= 0) continue;
      baseAmountNGN += payAmount;
      validatedItems.push({ fee_item_id: fp.fee_item_id, amount: payAmount, name: classFee.name });
    }

    if (baseAmountNGN <= 0) return json({ error: "No valid payments" }, 400);

    const baseKobo = Math.round(baseAmountNGN * 100);
    const platformFeeKobo = Math.round(baseKobo * PLATFORM_FEE_RATE);
    const totalKobo = grossUpKobo(baseKobo);
    const processingFeeKobo = totalKobo - baseKobo;

    // --- Ensure this school (branch) has a Paystack subaccount -------------
    const settings = (school.settings || {}) as Record<string, unknown>;
    let subaccountCode = settings.paystack_subaccount_code as string | undefined;

    if (!subaccountCode) {
      if (!school.bank_name || !school.account_number) {
        return json(
          { error: "This school has not set up its bank account for receiving payments. Ask the school owner to add bank details in Settings." },
          400
        );
      }

      // Resolve the Paystack bank code from the bank name stored at registration
      const bankRes = await fetch(`${PAYSTACK_API}/bank?currency=NGN&perPage=100`, {
        headers: { Authorization: `Bearer ${paystackKey}` },
      });
      const bankData = await bankRes.json();
      if (!bankRes.ok || !Array.isArray(bankData?.data)) {
        return json({ error: "Could not load bank list from payment provider" }, 502);
      }

      const target = normalizeBankName(school.bank_name);
      const bank = bankData.data.find((b: { name: string }) => {
        const candidate = normalizeBankName(b.name);
        return candidate === target || candidate.includes(target) || target.includes(candidate);
      });
      if (!bank) {
        return json(
          { error: `Could not match the school's bank ("${school.bank_name}") to a Paystack bank. Ask the school owner to re-select their bank in Settings.` },
          400
        );
      }

      const subRes = await fetch(`${PAYSTACK_API}/subaccount`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          business_name: school.name,
          settlement_bank: bank.code,
          account_number: school.account_number,
          percentage_charge: 0,
          description: `EduLedgerNG school ${school.slug || school.id}`,
        }),
      });
      const subData = await subRes.json();
      if (!subRes.ok || !subData?.data?.subaccount_code) {
        console.error("Subaccount creation failed:", JSON.stringify(subData));
        return json(
          { error: subData?.message || "Could not set up the school's settlement account. Check that the account number matches the selected bank." },
          502
        );
      }

      subaccountCode = subData.data.subaccount_code;
      await supabaseAdmin
        .from("schools")
        .update({
          settings: {
            ...settings,
            paystack_subaccount_code: subaccountCode,
            paystack_bank_code: bank.code,
          },
        })
        .eq("id", school.id);
    }

    // --- Initialize the transaction -----------------------------------------
    const reference = `EDU-PS-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

    const { data: studentRecord } = await supabaseAdmin
      .from("students")
      .select("parent_email")
      .eq("id", student.id)
      .maybeSingle();
    // Paystack validates the email strictly — fall back to a synthetic one when
    // the stored parent email is missing or malformed (typos happen).
    const emailOk = (e: unknown): e is string =>
      typeof e === "string" && /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e) && !e.endsWith(".test");
    const customerEmail = emailOk(studentRecord?.parent_email)
      ? studentRecord!.parent_email!
      : `${student_id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "student"}@eduledgerng.ng`;

    const initRes = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paystackKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: customerEmail,
        amount: totalKobo,
        currency: "NGN",
        reference,
        subaccount: subaccountCode,
        transaction_charge: platformFeeKobo,
        bearer: "subaccount",
        callback_url: typeof callback_url === "string" && callback_url.length < 500 ? callback_url : undefined,
        metadata: {
          reference,
          school_id: school.id,
          school_slug,
          student_db_id: student.id,
          student_id,
          base_amount: baseAmountNGN,
          platform_fee: platformFeeKobo / 100,
          processing_fee: processingFeeKobo / 100,
          total_ngn: totalKobo / 100,
          session_id: session_id || null,
          term_id: term_id || null,
          items: validatedItems,
        },
      }),
    });

    const initData = await initRes.json();
    if (!initRes.ok || !initData?.data?.authorization_url) {
      console.error("Paystack initialize failed:", JSON.stringify(initData));
      return json({ error: initData?.message || "Failed to start payment", details: initData }, 502);
    }

    return json({
      authorization_url: initData.data.authorization_url,
      reference,
      base_amount: baseAmountNGN,
      processing_fee: processingFeeKobo / 100,
      total_ngn: totalKobo / 100,
    });
  } catch (error) {
    console.error("Error in create-paystack-payment:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
