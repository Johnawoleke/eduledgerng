// settlement-status
//
// Can this school actually be paid?
//
// Paystack holds the FIRST payout to a new subaccount indefinitely until
// someone clicks "Verify Subaccounts" in the Paystack dashboard. There is no
// API for it — deliberately, since an automatable fraud check protects nobody
// (support.paystack.com/en/articles/2125314).
//
// So a school can take fees for a week and receive nothing, and nobody finds
// out until a parent asks where their money went. The state is readable via
// GET /subaccount/{code}, so the school is shown it rather than left guessing.
//
// It is NOT cached on our side: is_verified starts false and flips later, in a
// dashboard we do not control, with no callback. A stored copy would be stale
// exactly when it matters.
//
// Owner-only: this reveals whether a school's settlement is set up, which is
// nobody else's business.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireSchoolOwner } from "../_shared/schoolAuth.ts";
import { settlementKey, subaccountVerified } from "../_shared/gateways.ts";
import { getSettlement, cachedAccountId } from "../_shared/settlement.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { school_id } = await req.json();
    if (!school_id) return json({ error: "Missing required fields" }, 400);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const auth = await requireSchoolOwner(supabaseAdmin, req, school_id);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    const settlement = await getSettlement(supabaseAdmin, school_id);
    const hasBankDetails = Boolean(settlement.bankName && settlement.accountNumber);
    const code = cachedAccountId(settlement, settlementKey("paystack"));

    // No subaccount yet is not a problem: it is provisioned on the first
    // payment. Saying "not verified" here would be alarming and wrong.
    if (!code) {
      return json({
        has_bank_details: hasBankDetails,
        provisioned: false,
        verified: null,
        bank_name: settlement.bankName,
      });
    }

    return json({
      has_bank_details: hasBankDetails,
      provisioned: true,
      // null means we could not ask Paystack, which is NOT the same as false.
      // Showing "on hold" because a lookup failed would send a school chasing
      // support over nothing.
      verified: await subaccountVerified(code),
      bank_name: settlement.bankName,
    });
  } catch (error) {
    console.error("Error in settlement-status:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
