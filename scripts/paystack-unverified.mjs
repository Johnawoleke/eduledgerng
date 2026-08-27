#!/usr/bin/env node
// Which schools cannot be paid yet?
//
// Paystack holds the FIRST payout to a new subaccount indefinitely until
// someone clicks "Verify Subaccounts" in its dashboard. There is no API for it,
// deliberately (support.paystack.com/en/articles/2125314), so this cannot be
// automated away — but it CAN be made visible, which is the actual problem.
// Until now nothing anywhere reported that a school was collecting fees and
// receiving none of them.
//
// Also flags duplicate subaccounts pointing at the same bank account. Each
// duplicate is a second verification click, and settlement follows whichever
// one the transaction happened to use.
//
// Read-only. Lists and fetches; never creates, updates or moves money.
//
//   PAYSTACK_SECRET_KEY=sk_live_... node scripts/paystack-unverified.mjs
//
// Use the LIVE key to see real schools. A test key shows the test integration,
// which is a different set of subaccounts entirely.

const KEY = process.env.PAYSTACK_SECRET_KEY;
if (!KEY) {
  console.error("PAYSTACK_SECRET_KEY is not set.\n" +
    "  PAYSTACK_SECRET_KEY=sk_live_... node scripts/paystack-unverified.mjs");
  process.exit(1);
}

const get = async (path) => {
  const res = await fetch(`https://api.paystack.co${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const body = await res.json();
  if (!res.ok || body?.status === false) {
    throw new Error(`GET ${path} -> ${res.status} ${body?.message || ""}`);
  }
  return body;
};

const all = [];
for (let page = 1; page <= 50; page++) {
  const { data } = await get(`/subaccount?perPage=100&page=${page}`);
  if (!Array.isArray(data) || data.length === 0) break;
  all.push(...data);
  if (data.length < 100) break;
}

const mode = KEY.startsWith("sk_live_") ? "LIVE" : "TEST";
console.log(`\n${mode} integration — ${all.length} subaccount(s)\n`);

const unverified = all.filter((s) => s.is_verified === false);
const byAccount = new Map();
for (const s of all) {
  const k = String(s.account_number || "").replace(/\D/g, "");
  if (!k) continue;
  byAccount.set(k, [...(byAccount.get(k) || []), s]);
}
const duplicates = [...byAccount.entries()].filter(([, rows]) => rows.length > 1);

if (unverified.length === 0) {
  console.log("  Every subaccount is verified. All schools can be paid.\n");
} else {
  console.log(`  ${unverified.length} school(s) CANNOT be paid until verified in the`);
  console.log("  Paystack dashboard (Subaccounts -> select -> Verify Subaccounts):\n");
  for (const s of unverified) {
    console.log(`    ${s.subaccount_code}  ${String(s.business_name || "").slice(0, 34).padEnd(36)}` +
      `${s.settlement_bank || ""} ${s.account_number || ""}`);
  }
  console.log("");
}

if (duplicates.length > 0) {
  console.log(`  ${duplicates.length} bank account(s) have MORE THAN ONE subaccount.`);
  console.log("  Each one needs verifying separately, and settlement follows");
  console.log("  whichever the transaction used:\n");
  for (const [acct, rows] of duplicates) {
    console.log(`    ${acct}  ${rows[0].business_name || ""}`);
    for (const r of rows) {
      console.log(`      ${r.subaccount_code}  verified=${r.is_verified}  active=${r.active}`);
    }
  }
  console.log("");
}
