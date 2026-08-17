// Gateway adapters. One object per provider behind a common interface, so the
// payment edge functions never name a provider directly.
//
// Paystack is the only adapter. Squad lived here from 2026-08-06 to 2026-08-17
// and was removed without ever settling a payment — no school ever completed
// sub-merchant provisioning, so no historical row references it.
//
// The interface is kept rather than inlined into create-payment because adding
// Paystack for Education means a rate in gatewayMoney.ts plus a selectGateway()
// threshold, and payments.gateway already records the provider per row so
// verify and the webhook route correctly on their own.
//
// Backend only — this talks to provider APIs and reads secrets. The money maths
// lives in _shared/gatewayMoney.ts, which is mirrored to the frontend.
import type { GatewayId } from "./gatewayMoney.ts";
import { matchBankCode, type BankRef } from "./bankNames.ts";

export { matchBankCode, normaliseBankName, type BankRef } from "./bankNames.ts";

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
  /**
   * Is the attempt terminally over with no money coming? Distinct from
   * `!success`, which is also true while a charge is still in flight — see
   * isTerminalFailure.
   */
  failed: boolean;
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

/**
 * Statuses that mean the attempt is over and no money is coming.
 *
 * Everything else — pending, processing, ongoing, queued — is still in flight
 * and must NOT be written off. A bank transfer routinely has not confirmed by
 * the time the payer is redirected back from checkout, and marking that failed
 * both misreports it to the school and, if the webhook is later missed, asks
 * the student to pay a second time for money already collected.
 */
const TERMINAL_FAILURES = [
  "failed",
  "abandoned",
  "reversed",
  "cancelled",
  "canceled",
  "declined",
  "expired",
];

export const isTerminalFailure = (status: string): boolean =>
  TERMINAL_FAILURES.includes(String(status ?? "").toLowerCase());

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
    const status = String(d.status ?? "unknown");
    return {
      success: status === "success",
      failed: isTerminalFailure(status),
      status,
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
      failed: event === "charge.failed" || isTerminalFailure(status),
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

export const GATEWAY_ADAPTERS: Record<GatewayId, Gateway> = { paystack };

export const gatewayFor = (id: GatewayId): Gateway => GATEWAY_ADAPTERS[id] ?? paystack;

/**
 * Where a school's settlement account id lives in schools.settings, per gateway.
 *
 * Keyed per provider rather than one shared "settlement_account" so that adding
 * a gateway never clobbers another's cached id when routing changes. That is
 * why the two schools provisioned before the Squad episode still hold valid
 * paystack_subaccount_code values today and need no re-provisioning.
 *
 * Keep the guard_school_settlement_settings trigger's protected-key list in
 * step with this (migration 20260806110000).
 */
export const settlementKey = (_id: GatewayId): string => "paystack_subaccount_code";

/**
 * Every Nigerian bank Paystack publishes, following the cursor to the end.
 *
 * The NGN list runs well past one page once fintechs and microfinance banks are
 * included. The previous single `perPage=100` request truncated it silently, so
 * a school banking anywhere past the cut could not be matched at all.
 */
const fetchNigerianBanks = async (key: string): Promise<BankRef[]> => {
  const banks: BankRef[] = [];
  let next: string | null = null;

  for (let page = 0; page < 20; page++) {
    const url = new URL(`${PAYSTACK_API}/bank`);
    url.searchParams.set("currency", "NGN");
    url.searchParams.set("perPage", "100");
    url.searchParams.set("use_cursor", "true");
    if (next) url.searchParams.set("next", next);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data?.data)) break;

    banks.push(...(data.data as BankRef[]));
    next = (data?.meta?.next as string | null) ?? null;
    if (!next) break;
  }
  return banks;
};

/** Resolve a Nigerian bank name to the code a gateway expects. */
export const resolveBankCode = async (
  _gateway: Gateway,
  bankName: string
): Promise<string | null> => {
  // Paystack publishes the NIP bank list, and is also the gateway we create the
  // subaccount at, so one key covers both. Without PAYSTACK_SECRET_KEY there is
  // no lookup and the caller must supply a code another way.
  const key = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!key) return null;
  const banks = await fetchNigerianBanks(key);
  if (!banks.length) return null;
  return matchBankCode(banks, bankName);
};
