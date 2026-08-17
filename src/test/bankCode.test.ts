// Bank-name -> bank-code matching, from _shared/gateways.ts.
//
// This is the lookup that decides which bank a school's settlement account is
// created against. Getting it wrong does not fail loudly: the account is
// provisioned at the WRONG bank and then cached in schools.settings, so every
// later payment for that school settles there too.
//
// The matcher is imported straight from the Deno source rather than mirrored,
// so there is no second copy to drift. It lives in _shared/bankNames.ts
// precisely so it can be imported here: that module touches no Deno global, so
// importing it does not pull Deno types into the app typecheck.
import { describe, it, expect } from "vitest";
import { matchBankCode, normaliseBankName } from "../../supabase/functions/_shared/bankNames.ts";

// Real Paystack /bank entries, in the alphabetical order Paystack returns them.
// The ordering matters: it is what made the old first-match-wins implementation
// pick the wrong bank.
const BANKS = [
  { name: "Access Bank", code: "044" },
  { name: "Access Bank (Diamond)", code: "063" },
  { name: "Ecobank Nigeria", code: "050" },
  { name: "Fidelity Bank", code: "070" },
  { name: "First Bank of Nigeria", code: "011" },
  { name: "First City Monument Bank", code: "214" },
  { name: "Globus Bank", code: "00103" },
  { name: "Guaranty Trust Bank", code: "058" },
  { name: "Heritage Bank", code: "030" },
  { name: "Moniepoint MFB", code: "50515" },
  { name: "OPay Digital Services Limited (OPAY)", code: "999992" },
  { name: "PalmPay", code: "999991" },
  { name: "Sterling Bank", code: "232" },
  { name: "Zenith Bank", code: "057" },
];

describe("matchBankCode", () => {
  it("resolves FCMB to FCMB, not to First Bank", () => {
    // The regression. "First Bank of Nigeria" reduces to "first", which is a
    // prefix of "firstcitymonument", and First Bank sorts first — so the old
    // `target.includes(c)` test matched it and returned 011.
    expect(matchBankCode(BANKS, "First City Monument Bank (FCMB)")).toBe("214");
    expect(matchBankCode(BANKS, "First City Monument Bank")).toBe("214");
    expect(matchBankCode(BANKS, "First Bank of Nigeria")).toBe("011");
  });

  it("resolves every bank name currently stored on production schools", () => {
    const live: [string, string][] = [
      ["Access Bank", "044"],
      ["Ecobank Nigeria", "050"],
      ["First Bank of Nigeria", "011"],
      ["First City Monument Bank (FCMB)", "214"],
      ["Globus Bank", "00103"],
      ["Heritage Bank", "030"],
      ["Opay", "999992"],
      ["Palmpay", "999991"],
    ];
    for (const [stored, code] of live) {
      expect(matchBankCode(BANKS, stored), `stored name: ${stored}`).toBe(code);
    }
  });

  it("matches a short stored name against a long legal name", () => {
    // Owners type "Opay"; Paystack publishes "OPay Digital Services Limited".
    expect(matchBankCode(BANKS, "OPay")).toBe("999992");
    expect(matchBankCode(BANKS, "Moniepoint")).toBe("50515");
  });

  it("prefers an exact match over a longer superstring", () => {
    // "Access Bank (Diamond)" also contains "access", and is longer.
    expect(matchBankCode(BANKS, "Access Bank")).toBe("044");
  });

  it("returns null rather than guessing when nothing is close enough", () => {
    // Recoverable: create-payment tells the owner to re-select their bank.
    // A confident wrong answer is not recoverable.
    expect(matchBankCode(BANKS, "FCMB")).toBeNull();
    expect(matchBankCode(BANKS, "Some Bank That Does Not Exist")).toBeNull();
    expect(matchBankCode(BANKS, "")).toBeNull();
    expect(matchBankCode([], "Access Bank")).toBeNull();
  });
});

describe("normaliseBankName", () => {
  it("strips bracketed abbreviations and legal boilerplate", () => {
    expect(normaliseBankName("First City Monument Bank (FCMB)")).toBe("firstcitymonument");
    expect(normaliseBankName("First Bank of Nigeria")).toBe("first");
    expect(normaliseBankName("Ecobank Nigeria")).toBe("ecobank");
  });
});
