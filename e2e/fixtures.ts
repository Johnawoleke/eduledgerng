import { Page, Route } from "@playwright/test";

// Deterministic fixtures for a mocked school + student. Tuition is unpaid (₦5,000)
// and Books is fully paid (₦2,000) so the outstanding balance is exactly ₦5,000.
export const SCHOOL = { id: "school-1", name: "Test High School", slug: "test-school", settings: {} };
export const STUDENT = {
  id: "stu-1",
  student_id: "TST-1234",
  name: "Ada Test",
  class: "JSS1",
  must_change_pin: false,
  school_id: "school-1",
};
export const SESSION = { id: "sess-1", name: "2026/2027", start_year: 2026, end_year: 2027, is_current: true, school_id: "school-1" };
export const TERM = { id: "term-1", session_id: "sess-1", name: "Term 1", term_number: 1, is_current: true, school_id: "school-1" };
export const FEE_ITEMS = [
  { id: "fee-tuition", name: "Tuition", amount: 5000, paid: 0, status: "unpaid", session_id: "sess-1", term_id: "term-1" },
  { id: "fee-books", name: "Books", amount: 2000, paid: 2000, status: "paid", session_id: "sess-1", term_id: "term-1" },
];

export const studentAuthResponse = {
  student: STUDENT,
  school: SCHOOL,
  feeItems: FEE_ITEMS,
  payments: [] as unknown[],
  sessions: [SESSION],
  terms: [TERM],
};

export type Invocation = { name: string; body: Record<string, unknown> };

// Intercept every Supabase call and serve fixtures. Records edge-function
// invocations so tests can assert on them (e.g. what was sent to Paystack).
export async function mockSupabase(page: Page, invocations: Invocation[] = []): Promise<Invocation[]> {
  await page.route(/https:\/\/[a-z0-9]+\.supabase\.co\/.*/, async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.includes("/functions/v1/")) {
      const name = url.split("/functions/v1/")[1].split("?")[0];
      let body: Record<string, unknown> = {};
      try {
        body = req.postDataJSON() as Record<string, unknown>;
      } catch {
        /* no body */
      }
      invocations.push({ name, body });
      if (name === "student-auth") return json(studentAuthResponse);
      if (name === "student-set-pin") return json({ success: true });
      if (name === "create-paystack-payment") {
        return json({
          authorization_url: "http://localhost:8080/e2e/paystack-stub",
          reference: "EDU-PS-E2E-TEST",
          base_amount: 5000,
          processing_fee: 178.43,
          total_ngn: 5228.43,
        });
      }
      if (name === "verify-paystack-payment") return json({ success: false, status: "pending" });
      return json({});
    }

    if (url.includes("/rest/v1/schools")) return json(SCHOOL); // .maybeSingle() -> object
    if (url.includes("/rest/v1/sessions")) return json([SESSION]);
    if (url.includes("/rest/v1/terms")) return json([TERM]);
    if (url.includes("/rest/v1/")) return json([]);
    return json({});
  });

  // Stub the Paystack checkout the app redirects to, so we never hit real Paystack.
  await page.route("**/e2e/paystack-stub", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body><h1>Paystack Stub Checkout</h1></body></html>",
    })
  );

  return invocations;
}
