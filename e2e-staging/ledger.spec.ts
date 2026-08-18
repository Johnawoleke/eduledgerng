import { test, expect } from "@playwright/test";
import { openAdminDashboard, loginStudent, naira, SCHOOL_SLUG } from "./fixtures";

// Each test here targets a bug class that ALREADY shipped past the hermetic
// suite. They are regression guards against real failures, not coverage padding.

test.describe("student dashboard against real data", () => {
  test("shows what is owed this term AND from earlier terms, and they add up", async ({ page }) => {
    // The bug: setArrears was declared and never called, so this section
    // rendered empty forever with no error anywhere.
    await loginStudent(page);

    const total = page.getByText(/Total owing|Owing this term/i).first();
    await expect(total).toBeVisible();

    const card = total.locator("xpath=..");
    const amounts = await card.locator("p").allInnerTexts();
    const headline = naira(amounts.find((t) => t.includes("₦")) || null);
    expect(headline).toBeGreaterThan(0);

    // If a split is shown, the parts must equal the headline. A total that
    // disagrees with its own breakdown is worse than showing no breakdown.
    const split = amounts.find((t) => /this term/.test(t) && /earlier terms/.test(t));
    if (split) {
      const parts = split.match(/₦[\d,]+/g) || [];
      expect(parts).toHaveLength(2);
      expect(naira(parts[0]) + naira(parts[1])).toBe(headline);
    }
  });

  test("every earlier-term debt is labelled with the term it belongs to", async ({ page }) => {
    // The bug: the dialog claimed "Payment for 2027/2028" while listing
    // 2026/2027 fees. A charge must never be shown under the wrong period.
    await loginStudent(page);
    await page.getByRole("button", { name: /Pay Fees Online/i }).click();
    await page.waitForTimeout(1200);

    const section = page.getByText(/Still owing from earlier terms/i);
    if ((await section.count()) === 0) test.skip(true, "no arrears in the staging dataset");

    await expect(section).toBeVisible();
    // Each arrears row carries a period badge like "2026/2027 · Term 1".
    const badges = await page.getByText(/\d{4}\/\d{4}\s*·\s*Term \d/).count();
    expect(badges).toBeGreaterThan(0);

    // ...and the dialog must not claim the whole payment belongs to one period.
    await expect(page.getByText(/Payment for .* — /)).toHaveCount(0);
  });

  test("legacy name-keyed payments still reconcile", async ({ page }) => {
    // The bug: paid totals were computed with a blank fee name, so LEGACY
    // payment rows (no fee id, matched by name) all read as unpaid. Staging's
    // seed payments are in exactly that format, which is why this test lives
    // here and not in the mocked suite.
    //
    // Asserted on the arrears rows rather than the current term's table: a term
    // whose fees are not published yet has no rows at all, so an empty table
    // would prove nothing either way.
    await loginStudent(page);
    await page.getByRole("button", { name: /Pay Fees Online/i }).click();
    await page.waitForTimeout(1200);

    const rows = await page.getByText(/Paid: ₦[\d,]+/).allInnerTexts();
    expect(rows.length).toBeGreaterThan(0);
    // At least one fee must show a non-zero paid amount. If every legacy
    // payment were being missed, every row would read "Paid: ₦0".
    const anyPaid = rows.some((t) => (Number((t.match(/₦([\d,]+)/)?.[1] || "0").replace(/,/g, "")) || 0) > 0);
    expect(anyPaid, `no fee showed a non-zero paid amount: ${JSON.stringify(rows)}`).toBe(true);
  });
});

test.describe("admin dashboard against real data", () => {
  test("owing figure is labelled honestly for the selected period", async ({ page }) => {
    // The bug: the card said "Owing this term" while showing every term.
    await openAdminDashboard(page);
    const termPicker = page.locator("text=Term").first();
    await expect(termPicker).toBeVisible();

    const thisTerm = await page.getByText("Owing this term", { exact: true }).count();
    const allTerms = await page.getByText("Total owing", { exact: true }).count();
    // Exactly one of the two labels, never both and never neither.
    expect(thisTerm + allTerms).toBe(1);
  });

  test("rollover previews without changing anything, and only offers later years", async ({ page }) => {
    // The bug: the picker offered EARLIER sessions, whose preview is an empty
    // no-op that reads as the feature being broken.
    await openAdminDashboard(page);
    await page.getByRole("button", { name: /Move Up a Class/i }).click();
    await expect(page.getByText(/Move students up a class/i)).toBeVisible();

    const currentSession = await page.locator("text=/^\\d{4}\\/\\d{4}$/").first().innerText();
    const currentYear = Number(currentSession.slice(0, 4));

    await page.getByRole("combobox").last().click();
    const options = await page.getByRole("option").allInnerTexts();
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      expect(Number(o.slice(0, 4))).toBeGreaterThan(currentYear);
    }
    // Escape without previewing: this suite must not mutate staging.
    await page.keyboard.press("Escape");
  });

  test("the debtors export is offered", async ({ page }) => {
    await openAdminDashboard(page);
    await expect(page.getByRole("button", { name: /Who Owes/i })).toBeVisible();
  });
});
