import { test, expect } from "@playwright/test";

test.describe("Landing page", () => {
  test("loads with brand, promise, hero CTA, and all sections", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText(/Free for schools\. Always\./i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Secure Payments/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Get Started for Free/i }).first()).toBeVisible();

    for (const id of ["about", "features", "solutions", "pricing", "contact"]) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }

    await expect(page.getByRole("link", { name: /eduledgerng@gmail\.com/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /\+234 913 358 6788/ })).toBeVisible();
  });

  test("nav scrolls to the pricing section", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Pricing", exact: true }).first().click();
    await expect(page.locator("#pricing").getByText(/Your school pays nothing/i).first()).toBeVisible();
  });

  test("the whole page contains no em dashes (guards the 'reads as AI' rule)", async ({ page }) => {
    await page.goto("/");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("—");
  });
});
