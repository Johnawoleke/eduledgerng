// Bank-name -> bank-code matching.
//
// Split out of gateways.ts deliberately: this file touches no Deno global and
// no network, so src/test/bankCode.test.ts can import it directly under vitest
// without dragging Deno types into the app typecheck. Keep it that way — put
// anything that reads a secret or calls a provider in gateways.ts instead.

export interface BankRef {
  name: string;
  code: string;
}

/**
 * Reduce a bank name to a comparable core. The name a school stores and the one
 * Paystack publishes differ in punctuation, abbreviations in brackets and legal
 * boilerplate — "First City Monument Bank (FCMB)" against "First City Monument
 * Bank", "OPay Digital Services Limited (OPAY)" against "Opay".
 */
export const normaliseBankName = (n: string): string =>
  n
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\b(bank|of|nigeria|plc|the)\b/g, "")
    .replace(/[^a-z]/g, "");

/**
 * Pick the bank code for a school's stored bank name.
 *
 * An exact match wins outright. Failing that the LONGEST consistent candidate
 * wins — never simply the first one encountered, which is what this used to do
 * and why it was wrong. "First Bank of Nigeria" reduces to the five characters
 * "first"; Paystack returns the list alphabetically, so First Bank is reached
 * before First City Monument Bank and `target.includes(c)` matched it. A school
 * banking with FCMB was resolved to First Bank's code (011) instead of 214, and
 * the resulting settlement account was cached in schools.settings.
 *
 * Returning null is the safe failure: create-payment turns it into "re-select
 * your bank in Settings", which an owner can fix. A wrong code cannot be fixed
 * by anyone who does not already know it is wrong.
 */
export const matchBankCode = (banks: BankRef[], bankName: string): string | null => {
  const target = normaliseBankName(bankName);
  if (!target) return null;

  for (const b of banks) {
    if (normaliseBankName(b.name) === target) return b.code;
  }

  let best: { code: string; len: number } | null = null;
  for (const b of banks) {
    const c = normaliseBankName(b.name);
    if (!c) continue;
    if (!c.includes(target) && !target.includes(c)) continue;
    // A candidate under half the target's length is a shared prefix, not a
    // bank name. This is the guard that rejects "first" for "firstcitymonument".
    if (c.length * 2 < target.length) continue;
    if (!best || c.length > best.len) best = { code: b.code, len: c.length };
  }
  return best?.code ?? null;
};
