import { type Page, expect } from "@playwright/test";

// Staging test accounts (documented in CLAUDE.md). Read-only usage: these tests
// assert what the app DISPLAYS and never commit a rollover, change a class, or
// take a payment, so the dataset stays stable for the next run.
export const OWNER = { email: "owner@demo-staging.test", password: "Staging123!" };
export const STUDENT = { id: "OCD-1234", password: "Staging123!" };
export const SCHOOL_SLUG = "demo";

export async function loginOwner(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("admin@school.com").fill(OWNER.email);
  await page.getByPlaceholder("Your password").fill(OWNER.password);
  await page.getByRole("button", { name: /sign in/i }).first().click();
  await page.waitForURL(/main-dashboard|school/, { timeout: 40_000 });
}

export async function openAdminDashboard(page: Page) {
  await loginOwner(page);
  await page.goto(`/school/${SCHOOL_SLUG}/admin`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/Total Students/i)).toBeVisible({ timeout: 30_000 });
}

export async function loginStudent(page: Page) {
  await page.goto(`/school/${SCHOOL_SLUG}`);
  await page.getByPlaceholder("e.g. EDU/2024/001").fill(STUDENT.id);
  await page.getByPlaceholder("Enter your password").fill(STUDENT.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/student/, { timeout: 40_000 });
  await page.waitForLoadState("networkidle");
  // The period selector resolves AFTER the first data fetch, and the second
  // fetch is the one scoped to a session. Waiting for it is the difference
  // between reading a stale figure and the real one.
  await page.waitForTimeout(4000);
}

/** Naira text like "₦51,700" -> 51700. */
export const naira = (text: string | null): number =>
  Number((text || "").replace(/[^0-9.]/g, "")) || 0;
