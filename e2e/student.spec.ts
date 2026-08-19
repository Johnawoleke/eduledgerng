import { test, expect } from "@playwright/test";
import { mockSupabase, SESSION_TOKEN, type Invocation } from "./fixtures";

// Log in as the mocked student and land on the dashboard.
async function login(page: import("@playwright/test").Page) {
  await page.goto("/school/test-school");
  await page.getByPlaceholder("e.g. EDU/2024/001").fill("TST-1234");
  await page.getByPlaceholder("Enter your password").fill("password");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/school\/test-school\/student/);
  await expect(page.getByText(/Welcome, Ada/i)).toBeVisible();
}

test.describe("Student payment flow", () => {
  test("logs in and sees the dashboard", async ({ page }) => {
    await mockSupabase(page);
    await login(page);
    await expect(page.getByRole("button", { name: /^Pay ₦/ })).toBeVisible();
  });

  test("payment breakdown adds the 1% platform charge + gateway fee ON TOP of the fee", async ({ page }) => {
    const invocations: Invocation[] = [];
    await mockSupabase(page, invocations);
    await login(page);

    await page.getByRole("button", { name: /^Pay ₦/ }).click();

    // Only the unpaid Tuition (₦5,000) is selectable; Books is already paid.
    await page.getByRole("checkbox").first().check();

    // The school receives the full ₦5,000; the parent sees the charges on top.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("School Fees")).toBeVisible();
    await expect(dialog.getByText(/The school receives the full ₦5,000/)).toBeVisible();
    await expect(dialog.getByText("Platform Charge (1%)")).toBeVisible();
    await expect(dialog.getByText("₦50", { exact: true })).toBeVisible(); // 1% of ₦5,000
    await expect(dialog.getByText("Payment Processing Fee")).toBeVisible();
    // Total is grossed up above base + platform, using Paystack's 1.5% + ₦100
    // (the maths itself is covered by src/lib/gatewayMoney.test.ts).
    await expect(page.getByRole("button", { name: /Pay ₦5,228\.43/ })).toBeVisible();
  });

  test("paying calls create-payment with the fee and redirects to checkout", async ({ page }) => {
    const invocations: Invocation[] = [];
    await mockSupabase(page, invocations);
    await login(page);

    await page.getByRole("button", { name: /^Pay ₦/ }).click();
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: /^Pay ₦/ }).click();

    // Redirected to the (stubbed) gateway checkout — never the real thing.
    await expect(page.getByRole("heading", { name: "Gateway Stub Checkout" })).toBeVisible();

    const created = invocations.find((i) => i.name === "create-payment");
    expect(created).toBeTruthy();
    // Checkout is authorised by the session token — the student's password must
    // never be sent again after login.
    expect(created!.body.session_token).toBe(SESSION_TOKEN);
    expect(created!.body).not.toHaveProperty("pin");
    const feePayments = created!.body.fee_payments as { fee_item_id: string; amount: number }[];
    expect(feePayments).toEqual([{ fee_item_id: "fee-tuition", amount: 5000 }]);
  });
});

test.describe("Student self-service password change", () => {
  test("changes password via the dashboard and confirms success", async ({ page }) => {
    const invocations: Invocation[] = [];
    await mockSupabase(page, invocations);
    await login(page);

    await page.getByRole("button", { name: "Change password" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Current password").fill("password");
    await dialog.getByLabel("New password", { exact: true }).fill("newpass123");
    await dialog.getByLabel("Confirm new password").fill("newpass123");
    await dialog.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText(/signed out on any other devices/i)).toBeVisible();

    // Goes through change-pin, which re-authenticates with the CURRENT password:
    // a session token alone must not be enough to take over an account.
    const call = invocations.find((i) => i.name === "change-pin");
    expect(call).toBeTruthy();
    expect(call!.body).toMatchObject({
      student_id: "TST-1234",
      old_pin: "password",
      new_pin: "newpass123",
    });
  });
});
