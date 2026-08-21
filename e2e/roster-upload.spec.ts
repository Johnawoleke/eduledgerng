import { test, expect } from "@playwright/test";
import { mockAdmin, type Invocation } from "./fixtures";

// The roster upload is how a school gets its students in. It had no e2e cover,
// which is how a bug that silently discarded rows lived in it. These drive the
// real UI with real CSV files.
// Playwright runs from the project root.
const file = (n: string) => `e2e/files/${n}`;

async function openDashboard(page: import("@playwright/test").Page) {
  await page.goto("/school/test-school/admin");
  await expect(page.getByRole("button", { name: /Add Student/i })).toBeVisible({ timeout: 15000 });
}

async function upload(page: import("@playwright/test").Page, name: string) {
  // The input is hidden behind a styled button, so set files on it directly.
  await page.locator('input[type="file"]').setInputFiles(file(name));
}

test.describe("Roster upload", () => {
  test("a file whose classes we do not know is rejected, and says which and how many", async ({ page }) => {
    const calls: Invocation[] = [];
    await mockAdmin(page, calls);
    await openDashboard(page);
    await upload(page, "lively-kids.csv");

    // The exact failure the school hit: every row rejected.
    await expect(page.getByText(/None of the 14 row\(s\) could be added/i)).toBeVisible({ timeout: 10000 });

    // It must name the offending classes and the cost of each.
    const body = page.getByText(/Unrecognised classes/i);
    await expect(body).toBeVisible();
    await expect(body).toContainText('"Nur 1" (3 students)');
    await expect(body).toContainText("did you mean Nursery 1?");
    await expect(body).toContainText('"Pre-Nur 2" (2 students)');
    await expect(body).toContainText("Classes must be one of:");

    // And nothing may be written.
    expect(calls.find((c) => c.name === "students.insert")).toBeUndefined();
  });

  test("a partly valid file inserts the good rows AND reports the dropped ones", async ({ page }) => {
    // The dangerous case: this used to say "3 students uploaded" and lose the
    // rest without a word.
    const calls: Invocation[] = [];
    await mockAdmin(page, calls);
    await openDashboard(page);
    await upload(page, "mixed-roster.csv");

    await expect(page.getByText(/3 row\(s\) could not be added/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/3 student\(s\) uploaded/i)).toBeVisible();

    const insert = calls.find((c) => c.name === "students.insert");
    expect(insert).toBeTruthy();
    const rows = (insert!.body as { rows: { name: string; class: string }[] }).rows;
    expect(rows.map((r) => r.class).sort()).toEqual(["JSS1", "Primary 3", "SSS1"]);
    // The bad-class row must NOT have been quietly coerced into something.
    expect(rows.map((r) => r.name).join(" ")).not.toContain("Bad Class");
  });

  test("offers the failed rows as a download so they can be fixed and retried", async ({ page }) => {
    await mockAdmin(page);
    await openDashboard(page);
    await upload(page, "lively-kids.csv");

    await expect(page.getByText(/None of the 14 row\(s\)/i)).toBeVisible({ timeout: 10000 });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Download details/i }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("rows-we-could-not-add.csv");
  });
});
