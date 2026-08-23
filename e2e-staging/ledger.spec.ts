import { test, expect } from "@playwright/test";
import { openAdminDashboard, loginStudent, naira, SCHOOL_SLUG } from "./fixtures";

// Each test here targets a bug class that ALREADY shipped past the hermetic
// suite. They are regression guards against real failures, not coverage padding.

test.describe("student dashboard against real data", () => {
  test("the per-term subtotals add up to the headline total", async ({ page }) => {
    // Replaces a test that asserted the old "this term vs earlier terms" split.
    // That split was derived from the period selector and was the bug: with a
    // session chosen but no term it reported three terms of debt as one. The
    // card now groups by the term each debt belongs to, so the invariant worth
    // holding is that those groups reconcile to the headline.
    await loginStudent(page);
    if ((await page.getByText(/What you still owe/i).count()) === 0)
      test.skip(true, "this student owes nothing");

    const naira = (t: string) => Number((t.match(/₦[\d,]+/)?.[0] || "0").replace(/[^0-9]/g, ""));

    const headline = naira(
      await page.getByText(/₦[\d,]+ in total/).first().innerText()
    );
    // Each group header carries "<session> · <term>" and its subtotal.
    const rows = await page.locator("div").filter({
      hasText: /^\d{4}\/\d{4}\s*·\s*Term \d₦[\d,]+$/,
    }).allInnerTexts();
    expect(rows.length, "expected at least one per-term group").toBeGreaterThan(0);
    const summed = rows.reduce((a, t) => a + naira(t), 0);
    expect(summed, `groups ${JSON.stringify(rows)} should sum to ${headline}`).toBe(headline);
  });

  test("the three headline figures share one scope and add up", async ({ page }) => {
    // They used to mix scopes: "Term Fees" and "Amount Paid" were for the
    // selected period while "Total owing" was for every period, so the row read
    // "billed nothing, paid nothing, owe 51,700". Individually correct, together
    // nonsense. All three are now all-terms, which makes them checkable.
    await loginStudent(page);
    const money = async (label: RegExp) => {
      const card = page.locator("div").filter({ hasText: label }).last();
      const txt = await card.innerText();
      const m = txt.match(/₦[\d,]+/);
      return Number((m?.[0] || "0").replace(/[^0-9]/g, ""));
    };
    const billed = await money(/Fees so far/);
    const paid   = await money(/Paid so far/);
    const owing  = await money(/Still owing/);
    expect(billed - paid, `billed ${billed} - paid ${paid} should equal owing ${owing}`).toBe(owing);
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

    const all = page.getByRole("button", { name: /^All classes \(\d+\)$/ });
    await expect(all).toBeVisible();
    await expect(page.locator("table tbody tr")).not.toHaveCount(0);
  });

  test("every class on the ladder is listed, not only the ones with pupils in them", async ({ page }) => {
    // The roster listed only classes with a head count, to keep the row short.
    // A school then had no way to see the classes it had not set up yet, which
    // is exactly what a new school needs on first login — and no way to tell an
    // empty class from one the app does not offer.
    await openAdminDashboard(page);

    for (const cls of ["Nursery 1", "Primary 1", "Primary 6", "JSS1", "SSS3"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${cls} ?\\d+$`) }))
        .toBeVisible();
    }
    // A class with nobody in it is still there, still shows its zero, and is
    // still clickable.
    const sss3 = page.getByRole("button", { name: /^SSS3 ?\d+$/ });
    await expect(sss3).toBeVisible();
    await expect(sss3).toBeEnabled();
  });

  test("a class offers to move up to the class above it", async ({ page }) => {
    // The owner's path: open a class, move that class up. The button has to
    // name where they are going, because "Promote" alone does not say whether
    // it means this class or the whole school.
    await openAdminDashboard(page);
    await page.getByRole("button", { name: /^JSS1 ?\d+$/ }).click();
    await expect(
      page.getByRole("button", { name: /Move JSS1 up to JSS2/i })
    ).toBeVisible();
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
