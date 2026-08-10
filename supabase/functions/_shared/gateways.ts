// Gateway adapters. One object per provider behind a common interface, so the
// payment edge functions never name a provider directly.
//
// Adding Paystack for Education later is: add its rate to gatewayMoney.ts, give
// selectGateway() a threshold, and set the PAYSTACK_SECRET_KEY secret. The
// adapter below already exists and every payment row already records which
// gateway processed it, so verify and the webhooks route correctly on their own.
//
// Backend only — this talks to provider APIs and reads secrets. The money maths
// lives in _shared/gatewayMoney.ts, which is mirrored to the frontend.
import type { GatewayId } from "./gatewayMoney.ts";

export interface InitArgs {
  reference: string;
  /** Total to charge the parent, in kobo. */
  amountKobo: number;
  /** The platform's cut, in kobo — kept by us, not the school. */
  platformFeeKobo: number;
  email: string;
  customerName?: string;
  callbackUrl?: string;
  /** The school's settlement account at this gateway, if provisioned. */
  settlementAccountId?: string;
  metadata: Record<string, unknown>;
}

export interface InitResult {
  checkoutUrl: string;
  raw: unknown;
}

export interface VerifyResult {
  /** Did the payment succeed? */
  success: boolean;
  /** Provider's own status string, for logging. */
  status: string;
  /** What was actually collected, in kobo. Null when the provider doesn't say. */
  amountPaidKobo: number | null;
  metadata: Record<string, unknown>;
  raw: unknown;
}

export interface SettlementArgs {
  schoolName: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  /** Resolved bank code, when the caller already has one. */
  bankCode?: string;
}

export interface Gateway {
  id: GatewayId;
  /** Reference prefix, so a reference is traceable to its gateway by eye. */
  refPrefix: string;
  secret(): string | undefined;
  initialize(args: InitArgs): Promise<InitResult>;
  verify(reference: string): Promise<VerifyResult>;
  /** Verify a webhook's signature against the raw body. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;
  /** Pull the useful bits out of a webhook payload. */
  parseWebhook(payload: Record<string, unknown>): {
    event: string;
    reference: string;
    success: boolean;
    failed: boolean;
    amountPaidKobo: number | null;
    metadata: Record<string, unknown>;
  };
  /** Create the school's settlement account. Returns the provider's id for it. */
  createSettlementAccount(args: SettlementArgs): Promise<{ id: string; extra?: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
};

const hmacHex = async (
  secret: string,
  payload: string,
  hash: "SHA-256" | "SHA-512"
): Promise<string> => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

// ---------------------------------------------------------------------------
// Squad (HabariPay) — the active gateway
// ---------------------------------------------------------------------------

const SQUAD_API = () =>
  Deno.env.get("SQUAD_ENV") === "sandbox"
    ? "https://sandbox-api-d.squadco.com"
    : "https://api-d.squadco.com";

export const squad: Gateway = {
  id: "squad",
  refPrefix: "EDU-SQ",
  secret: () => Deno.env.get("SQUAD_SECRET_KEY"),

  async initialize(args) {
    const key = this.secret();
    if (!key) throw new Error("SQUAD_SECRET_KEY not set");

    const body: Record<string, unknown> = {
      amount: args.amountKobo,
      email: args.email,
      currency: "NGN",
      initiate_type: "inline",
      transaction_ref: args.reference,
      customer_name: args.customerName,
      callback_url: args.callbackUrl,
      // We gross up ourselves in gatewayMoney.ts so the school receives its fee
      // exactly. pass_charge would make Squad do its own gross-up on top, which
      // would double-charge the parent.
      pass_charge: false,
      metadata: args.metadata,
    };
    // Verified against docs.squadco.com/Payments/Initiate-payment on
    // 2026-08-10. Squad's wording: "the ID of a merchant that was created by an
    // aggregator which allows the aggregator initiate a transaction on behalf of
    // the submerchant. This parameter is an optional field that is passed only
    // by a registered aggregator."
    //
    // REQUIRES the platform's Squad account to be registered as an aggregator.
    // If it is not, Squad ignores this field rather than erroring, and the whole
    // payment settles into the PLATFORM account instead of the school's — with
    // everything downstream still looking healthy. That is a business
    // arrangement with Squad, not something the code can assert.
    if (args.settlementAccountId) body.sub_merchant_id = args.settlementAccountId;

    const res = await fetch(`${SQUAD_API()}/transaction/initiate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const url = data?.data?.checkout_url;
    if (!res.ok || !url) {
      throw new Error(data?.message || "Squad could not start the payment");
    }
    return { checkoutUrl: url, raw: data };
  },

  // GET /transaction/verify/{transaction_ref} — verified against
  // docs.squadco.com on 2026-08-10. Response: { status, success, message,
  // data: { transaction_amount, transaction_ref, transaction_status, ... } }.
  //
  // Squad's field spec says metadata "will be returned via webhook and the
  // payment verification endpoint", but their documented sample verify response
  // does not include it, and the key it would arrive under is unstated. So the
  // underpayment guard does not depend on it: it reads expected_total_kobo off
  // our own payments row (see recordPayment.ts) and falls back to the echo only
  // for rows that predate that column.
  async verify(reference) {
    const key = this.secret();
    if (!key) throw new Error("SQUAD_SECRET_KEY not set");
    const res = await fetch(
      `${SQUAD_API()}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    const data = await res.json();
    const d = data?.data ?? {};
    const status = String(d.transaction_status ?? d.status ?? "").toLowerCase();
    return {
      success: status === "success" || status === "successful",
      status: status || "unknown",
      amountPaidKobo: Number.isFinite(Number(d.transaction_amount ?? d.amount))
        ? Number(d.transaction_amount ?? d.amount)
        : null,
      metadata: (d.meta ?? d.metadata ?? {}) as Record<string, unknown>,
      raw: data,
    };
  },

  async verifyWebhook(rawBody, headers) {
    const key = this.secret();
    if (!key) return false;
    // Squad signs the raw body with HMAC-SHA512 and sends it as
    // x-squad-encrypted-body. Some of their samples use x-squad-signature, and
    // the hex casing varies between their PHP and Node examples, so accept both
    // header names and compare case-insensitively.
    const provided = (
      headers.get("x-squad-encrypted-body") ||
      headers.get("x-squad-signature") ||
      ""
    ).trim().toLowerCase();
    if (!provided) return false;
    const expected = await hmacHex(key, rawBody, "SHA-512");
    return constantTimeEqual(expected, provided);
  },

  // Payload shape verified against docs.squadco.com on 2026-08-10:
  //   { Event: "charge_successful", TransactionRef, Body: { amount,
  //     transaction_ref, transaction_status, meta, merchant_amount, ... } }
  // transaction_status is capitalised ("Success" | "Failed" | "Abandoned" |
  // "Pending"), hence the lowercasing.
  //
  // Note `amount` is the gross charged and `merchant_amount` is what settles
  // after Squad's cut. The underpayment guard compares against the gross, which
  // is what we asked the parent for — do not switch it to merchant_amount.
  parseWebhook(payload) {
    const d = (payload.Body ?? payload.body ?? payload.data ?? payload) as Record<string, unknown>;
    const event = String(payload.Event ?? payload.event ?? "").toLowerCase();
    const status = String(d.transaction_status ?? d.status ?? "").toLowerCase();
    return {
      event: event || status || "unknown",
      reference: String(
        d.transaction_ref ?? payload.TransactionRef ?? d.transactionRef ?? d.reference ?? ""
      ),
      success: status === "success" || status === "successful",
      // "abandoned" means the payer left checkout without paying. Treat it as
      // failed so the attempt stops sitting in the admin's list as pending.
      failed: status === "failed" || status === "abandoned" || status === "reversed",
      amountPaidKobo: Number.isFinite(Number(d.amount ?? d.transaction_amount))
        ? Number(d.amount ?? d.transaction_amount)
        : null,
      metadata: (d.meta ?? d.metadata ?? {}) as Record<string, unknown>,
    };
  },

  async createSettlementAccount(args) {
    const key = this.secret();
    if (!key) throw new Error("SQUAD_SECRET_KEY not set");
    if (!args.bankCode) throw new Error("A bank code is required to create a Squad sub-merchant");

    const res = await fetch(`${SQUAD_API()}/merchant/create-sub-users`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: args.schoolName,
        account_name: args.accountName,
        account_number: args.accountNumber,
        bank_code: args.bankCode,
        bank: args.bankName,
      }),
    });
    const data = await res.json();
    const id = data?.data?.account_id ?? data?.account_id;
    if (!res.ok || !id) {
      throw new Error(data?.message || "Squad could not create the school's settlement account");
    }
    return { id: String(id), extra: { squad_bank_code: args.bankCode } };
  },
};

// ---------------------------------------------------------------------------
// Paystack — retained, currently unrouted. Ready for Paystack for Education.
// ---------------------------------------------------------------------------

const PAYSTACK_API = "https://api.paystack.co";

export const paystack: Gateway = {
  id: "paystack",
  refPrefix: "EDU-PS",
  secret: () => Deno.env.get("PAYSTACK_SECRET_KEY"),

  async initialize(args) {
    const key = this.secret();
    if (!key) throw new Error("PAYSTACK_SECRET_KEY not set");

    const body: Record<string, unknown> = {
      email: args.email,
      amount: args.amountKobo,
      currency: "NGN",
      reference: args.reference,
      callback_url: args.callbackUrl,
      metadata: args.metadata,
    };
    if (args.settlementAccountId) {
      body.subaccount = args.settlementAccountId;
      body.transaction_charge = args.platformFeeKobo;
      body.bearer = "subaccount";
    }

    const res = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const url = data?.data?.authorization_url;
    if (!res.ok || !url) throw new Error(data?.message || "Paystack could not start the payment");
    return { checkoutUrl: url, raw: data };
  },

  async verify(reference) {
    const key = this.secret();
    if (!key) throw new Error("PAYSTACK_SECRET_KEY not set");
    const res = await fetch(
      `${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    const data = await res.json();
    const d = data?.data ?? {};
    return {
      success: d.status === "success",
      status: String(d.status ?? "unknown"),
      amountPaidKobo: Number.isFinite(Number(d.amount)) ? Number(d.amount) : null,
      metadata: (d.metadata ?? {}) as Record<string, unknown>,
      raw: data,
    };
  },

  async verifyWebhook(rawBody, headers) {
    const key = this.secret();
    if (!key) return false;
    const provided = (headers.get("x-paystack-signature") || "").trim();
    if (!provided) return false;
    const expected = await hmacHex(key, rawBody, "SHA-512");
    return constantTimeEqual(expected, provided);
  },

  parseWebhook(payload) {
    const event = String(payload.event ?? "");
    const d = (payload.data ?? {}) as Record<string, unknown>;
    const status = String(d.status ?? "");
    return {
      event: event || status || "unknown",
      reference: String(d.reference ?? ""),
      success: event === "charge.success" && status === "success",
      failed: event === "charge.failed" || status === "failed",
      amountPaidKobo: Number.isFinite(Number(d.amount)) ? Number(d.amount) : null,
      metadata: (d.metadata ?? {}) as Record<string, unknown>,
    };
  },

  async createSettlementAccount(args) {
    const key = this.secret();
    if (!key) throw new Error("PAYSTACK_SECRET_KEY not set");
    if (!args.bankCode) throw new Error("A bank code is required to create a Paystack subaccount");

    const res = await fetch(`${PAYSTACK_API}/subaccount`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        business_name: args.schoolName,
        settlement_bank: args.bankCode,
        account_number: args.accountNumber,
        percentage_charge: 0,
      }),
    });
    const data = await res.json();
    const code = data?.data?.subaccount_code;
    if (!res.ok || !code) {
      throw new Error(data?.message || "Paystack could not create the school's subaccount");
    }
    return { id: String(code), extra: { paystack_bank_code: args.bankCode } };
  },
};

export const GATEWAY_ADAPTERS: Record<GatewayId, Gateway> = { squad, paystack };

export const gatewayFor = (id: GatewayId): Gateway => GATEWAY_ADAPTERS[id] ?? squad;

/**
 * Where a school's settlement account id lives in schools.settings, per gateway.
 * Separate keys so a school can be provisioned on both without one clobbering
 * the other when routing changes.
 */
export const settlementKey = (id: GatewayId): string =>
  id === "squad" ? "squad_sub_merchant_id" : "paystack_subaccount_code";

/** Resolve a Nigerian bank name to the code a gateway expects. */
export const resolveBankCode = async (
  gateway: Gateway,
  bankName: string
): Promise<string | null> => {
  // Both providers accept NIP bank codes; Paystack publishes the list, so it is
  // used as the lookup for either. Requires PAYSTACK_SECRET_KEY to be set even
  // when Squad is the active gateway — if it is not, the caller must supply a
  // code another way.
  const key = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!key) return null;
  const res = await fetch(`${PAYSTACK_API}/bank?currency=NGN&perPage=100`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json();
  if (!res.ok || !Array.isArray(data?.data)) return null;

  const normalise = (n: string) =>
    n.toLowerCase().replace(/\(.*?\)/g, "").replace(/\b(bank|of|nigeria|plc|the)\b/g, "").replace(/[^a-z]/g, "");
  const target = normalise(bankName);
  const hit = data.data.find((b: { name: string }) => {
    const c = normalise(b.name);
    return c === target || c.includes(target) || target.includes(c);
  });
  return hit?.code ?? null;
};
