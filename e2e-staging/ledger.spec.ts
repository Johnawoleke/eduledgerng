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

  test("the owing total does not change with the session or term selector", async ({ page }) => {
    // The bug: the this-term/earlier split was derived from the period selector,
    // which is a browsing control. With a session chosen but no term, three
    // terms of debt collapsed into "this term" and nothing read as earlier.
    // What a student owes is a fact about them, not about a dropdown.
    await loginStudent(page);
    const readTotal = async () =>
      (await page.getByText(/₦[\d,]+ in total/).first().innerText()).match(/₦[\d,]+/)![0];

    if ((await page.getByText(/What you still owe/i).count()) === 0)
      test.skip(true, "this student owes nothing");

    const before = await readTotal();
    await page.locator("button").filter({ hasText: /^\d{4}\/\d{4}$/ }).first().click();
    await page.waitForTimeout(500);
    const options = page.getByRole("option");
    if ((await options.count()) > 1) {
      await options.nth(1).click();
      await page.waitForTimeout(4000);
      expect(await readTotal()).toBe(before);
    }
  });

  test("every debt is grouped under the term it belongs to", async ({ page }) => {
    // A charge must never be shown under the wrong period. The dialog once
    // claimed "Payment for 2027/2028" while listing 2026/2027 fees.
    //
    // Asserted on the group HEADINGS, not on a fixed section title: the previous
    // version looked for "Still owing from earlier terms", which stopped
    // existing when the card was regrouped by term — so it skipped itself and
    // reported nothing. A test that silently opts out is worse than no test.
    await loginStudent(page);
    if ((await page.getByText(/What you still owe/i).count()) === 0)
      test.skip(true, "this student owes nothing");

    // Every group is headed by the period it covers.
    const headings = page.getByText(/^\d{4}\/\d{4}\s*·\s*Term \d$/);
    expect(await headings.count()).toBeGreaterThan(0);

    // The same holds inside the payment dialog, which must not claim the whole
    // payment belongs to whichever period the selector happens to show.
    await page.getByRole("button", { name: /^Pay ₦/ }).click();
    await page.waitForTimeout(1200);
    await expect(page.getByText(/Payment for .* — /)).toHaveCount(0);
    expect(await page.getByRole("dialog").getByText(/\d{4}\/\d{4}\s*·\s*Term \d/).count())
      .toBeGreaterThan(0);
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
    await page.getByRole("button", { name: /^Pay ₦/ }).click();
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
    // Occasional actions live behind "More" — a once-a-year action that rewrites
    // every student's class should not sit next to "Add Student".
    await page.getByRole("button", { name: /^More$/ }).click();
    await page.getByRole("menuitem", { name: /Move everyone up a class/i }).click();
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

  test("an Owing view shows who owes what, in which term, without changing period", async ({ page }) => {
    // The figures existed but were unreachable: the all-terms total showed only
    // when NO term was selected, and the debtors list was a CSV download. There
    // was no way to see which student owed what in which term.
    await openAdminDashboard(page);
    await page.getByRole("tab", { name: /Owing/i }).click();
    await expect(page.getByText(/Who owes, across all terms/i)).toBeVisible();

    const body = await page.locator("body").innerText();
    if (/Every student is up to date/i.test(body)) test.skip(true, "no debtors in the dataset");

    // Each debt must name the period it belongs to, or the list cannot be acted on.
    await expect(page.getByText(/\d{4}\/\d{4}\s*·\s*Term \d/).first()).toBeVisible();
  });

  test("the debtors export is offered", async ({ page }) => {
    await openAdminDashboard(page);
    await page.getByRole("button", { name: /^More$/ }).click();
    await expect(page.getByRole("menuitem", { name: /Who owes/i })).toBeVisible();
  });

  test("the roster shows everyone by default, and never a crash", async ({ page }) => {
    // Two faults this guards, both of which typecheck and the hermetic suite
    // were blind to:
    //   - the page threw at runtime because a derived value was declared above
    //     the one it depended on ("Cannot access X before initialization");
    //   - the roster defaulted to a single class filter, so a school with
    //     nobody in that class opened to "No students found".
    await openAdminDashboard(page);
    await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);

    const all = page.getByRole("button", { name: /^All \(\d+\)$/ });
    await expect(all).toBeVisible();
    await expect(page.locator("table tbody tr")).not.toHaveCount(0);
  });

  test("a student's class can be changed from the roster row", async ({ page }) => {
    // It used to live inside the fees panel, so correcting a mistyped class
    // meant opening a screen about money first.
    await openAdminDashboard(page);
    await page.locator("table tbody tr").first().getByRole("button").last().click();
    await expect(page.getByRole("menuitem", { name: /Change class/i })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("temporary passwords are not printed into the roster", async ({ page }) => {
    // Every un-rotated student's password used to be on screen at once.
    await openAdminDashboard(page);
    await expect(page.getByText(/^Temp password:/)).toHaveCount(0);
  });
});
