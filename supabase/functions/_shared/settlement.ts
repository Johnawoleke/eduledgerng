// A school's settlement details: which bank account its fee income lands in,
// and the cached gateway account id that routes it there.
//
// These used to be columns on `schools`. That table's SELECT policy is
// `using(true)` — it has to be, because the portal shows a school's name before
// anyone logs in and students hold no JWT — so every school's bank account
// number was readable by anyone with the public anon key. Verified against
// production on 2026-08-23: 32 schools, all of them. RLS is row-level, so the
// only fix was to move the columns to a table with a member-scoped policy
// (migration 20260823120000).
//
// Reading goes through here rather than each caller writing its own select, so
// there is one definition of where settlement details live. The row may not
// exist at all — a school that has never entered bank details has no row, which
// is not an error, it is "not set up yet".
import type { GatewayId } from "./gatewayMoney.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface Settlement {
  bankName: string | null;
  accountNumber: string | null;
  accountName: string | null;
  settings: Record<string, unknown>;
}

const EMPTY: Settlement = {
  bankName: null, accountNumber: null, accountName: null, settings: {},
};

/** A school's settlement details, or an empty one if it has never set them. */
export const getSettlement = async (
  admin: Admin,
  schoolId: string
): Promise<Settlement> => {
  const { data } = await admin
    .from("school_settlement")
    .select("bank_name, account_number, account_name, settings")
    .eq("school_id", schoolId)
    .maybeSingle();

  if (!data) return { ...EMPTY };
  return {
    bankName: data.bank_name ?? null,
    accountNumber: data.account_number ?? null,
    accountName: data.account_name ?? null,
    settings: (data.settings ?? {}) as Record<string, unknown>,
  };
};

/**
 * Cache a freshly provisioned settlement account id.
 *
 * Upsert, not update: a school can reach checkout with bank details but no row
 * if they were entered before this table existed, and losing the id would make
 * every payment re-provision a new subaccount at the gateway.
 */
export const cacheSettlementAccount = async (
  admin: Admin,
  schoolId: string,
  current: Settlement,
  key: string,
  accountId: string,
  extra: Record<string, unknown> = {}
): Promise<void> => {
  await admin.from("school_settlement").upsert(
    {
      school_id: schoolId,
      bank_name: current.bankName,
      account_number: current.accountNumber,
      account_name: current.accountName,
      settings: { ...current.settings, [key]: accountId, ...extra },
    },
    { onConflict: "school_id" }
  );
};

/** The cached settlement account id for a gateway, if there is one. */
export const cachedAccountId = (
  settlement: Settlement,
  key: string
): string | undefined => {
  const v = settlement.settings[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

export type { GatewayId };
