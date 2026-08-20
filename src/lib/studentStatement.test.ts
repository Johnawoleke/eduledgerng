import { describe, it, expect } from "vitest";
import { buildStatement, statementToCsv, type StatementInput } from "./studentStatement";
import { encodeFeeItem } from "./feeItems";

const TUITION = "11111111-1111-4111-8111-111111111111";
const BOOKS = "22222222-2222-4222-8222-222222222222";
const TRANSPORT = "33333333-3333-4333-8333-333333333333";

const base = (): StatementInput => ({
  student: { id: "s1", student_id: "OCD-1234", name: "Okafor Chinedu", class: "SSS3", status: "graduated" },
  school: { name: "Demo High School" },
  sessions: [{ id: "sess-1", name: "2024/2025" }, { id: "sess-2", name: "2025/2026" }],
  terms: [
    { id: "t1", name: "Term 1", session_id: "sess-1", term_number: 1 },
    { id: "t2", name: "Term 2", session_id: "sess-1", term_number: 2 },
    { id: "t3", name: "Term 1", session_id: "sess-2", term_number: 1 },
  ],
  fees: [
    { id: TUITION, name: "Tuition" },
    { id: BOOKS, name: "Books" },
    { id: TRANSPORT, name: "Transport" },
  ],
  enrolments: [
    { session_id: "sess-1", class: "SSS2", status: "promoted" },
    { session_id: "sess-2", class: "SSS3", status: "graduated" },
  ],
  charges: [
    { class_fee_id: TUITION, amount: 50000, session_id: "sess-1", term_id: "t1" },
    { class_fee_id: BOOKS, amount: 5000, session_id: "sess-1", term_id: "t2" },
    { class_fee_id: TRANSPORT, amount: 8000, session_id: "sess-2", term_id: "t3" },
  ],
  payments: [
    { reference: "EDU-1", date: "2024-09-10", method: "Paystack", amount: 50000,
      items: [encodeFeeItem(TUITION, "Tuition", 50000)], status: "success" },
    { reference: "EDU-2", date: "2025-01-15", method: "Paystack", amount: 3000,
      items: [encodeFeeItem(BOOKS, "Books", 3000)], status: "success" },
  ],
});

describe("buildStatement", () => {
  it("groups by session, oldest first, with the class held THAT year", () => {
    const s = buildStatement(base());
    expect(s.periods.map((p) => p.sessionName)).toEqual(["2024/2025", "2025/2026"]);
    // Not "SSS3" — the class they were actually in that year.
    expect(s.periods[0].className).toBe("SSS2");
    expect(s.periods[1].className).toBe("SSS3");
  });

  it("reports the outcome of each year in plain words", () => {
    const s = buildStatement(base());
    expect(s.periods[0].outcome).toBe("Moved up");
    expect(s.periods[1].outcome).toBe("Finished school");
  });

  it("totals charged, paid and outstanding across every year", () => {
    const s = buildStatement(base());
    expect(s.totalCharged).toBe(63000);      // 50000 + 5000 + 8000
    expect(s.totalPaid).toBe(53000);         // 50000 + 3000
    expect(s.totalOutstanding).toBe(10000);  // 2000 books + 8000 transport
  });

  it("credits a part-payment to the right fee and carries the remainder", () => {
    const s = buildStatement(base());
    const books = s.periods[0].lines.find((l) => l.feeName === "Books")!;
    expect(books).toMatchObject({ charged: 5000, paid: 3000, outstanding: 2000 });
  });

  it("never lets a payment exceed what was charged", () => {
    const i = base();
    i.payments.push({ reference: "EDU-3", date: "2025-02-01", method: "Paystack", amount: 99999,
      items: [encodeFeeItem(BOOKS, "Books", 99999)], status: "success" });
    const s = buildStatement(i);
    const books = s.periods[0].lines.find((l) => l.feeName === "Books")!;
    expect(books.paid).toBe(5000);
    expect(books.outstanding).toBe(0);
  });

  it("ignores pending and failed attempts", () => {
    const i = base();
    i.payments.push({ reference: "EDU-P", date: "2025-03-01", method: "Paystack", amount: 8000,
      items: [encodeFeeItem(TRANSPORT, "Transport", 8000)], status: "pending" });
    i.payments.push({ reference: "EDU-F", date: "2025-03-02", method: "Paystack", amount: 8000,
      items: [encodeFeeItem(TRANSPORT, "Transport", 8000)], status: "failed" });
    const s = buildStatement(i);
    expect(s.totalPaid).toBe(53000);
    expect(s.periods[1].outstanding).toBe(8000);
    expect(s.payments.map((p) => p.reference)).toEqual(["EDU-1", "EDU-2"]);
  });

  it("still reconciles legacy name-keyed payment lines", () => {
    const i = base();
    i.payments = [{ reference: "OLD-1", date: "2024-09-10", method: "Paystack", amount: 50000,
      items: ["Tuition|50000"], status: "success" }];
    const s = buildStatement(i);
    expect(s.periods[0].lines.find((l) => l.feeName === "Tuition")!.paid).toBe(50000);
  });

  it("does not cross-credit two fees sharing a name once ids are present", () => {
    const i = base();
    i.fees.push({ id: "44444444-4444-4444-8444-444444444444", name: "Transport" });
    i.charges.push({ class_fee_id: "44444444-4444-4444-8444-444444444444", amount: 8000, session_id: "sess-2", term_id: "t3" });
    i.payments.push({ reference: "EDU-T", date: "2025-04-01", method: "Paystack", amount: 8000,
      items: [encodeFeeItem(TRANSPORT, "Transport", 8000)], status: "success" });
    const s = buildStatement(i);
    const transports = s.periods[1].lines.filter((l) => l.feeName === "Transport");
    expect(transports.map((t) => t.paid).sort()).toEqual([0, 8000]);
  });

  it("survives a fee that no longer exists rather than dropping the charge", () => {
    const i = base();
    i.fees = [];
    const s = buildStatement(i);
    expect(s.totalCharged).toBe(63000);
    expect(s.periods[0].lines[0].feeName).toBe("(fee no longer listed)");
  });

  it("lists payments oldest first with the fees each one covered", () => {
    const s = buildStatement(base());
    expect(s.payments[0]).toMatchObject({ reference: "EDU-1", covers: ["Tuition"] });
    expect(s.payments[1]).toMatchObject({ reference: "EDU-2", covers: ["Books"] });
  });

  it("handles a student with no history at all", () => {
    const i = base();
    i.charges = []; i.payments = []; i.enrolments = [];
    const s = buildStatement(i);
    expect(s.periods).toEqual([]);
    expect(s.totalCharged).toBe(0);
    expect(s.totalOutstanding).toBe(0);
  });
});

describe("statementToCsv", () => {
  it("includes every charge row, the totals, and the payment log", () => {
    const csv = statementToCsv(buildStatement(base()));
    expect(csv).toContain("OCD-1234");
    expect(csv).toContain("Tuition");
    expect(csv).toContain("Total charged");
    expect(csv).toContain("EDU-1");
    expect(csv.split("\n").filter((r) => r.includes("2024/2025")).length).toBe(2);
  });

  it("escapes a fee name containing a comma or quote", () => {
    const i = base();
    i.fees = [{ id: TUITION, name: 'Tuition, "special"' }, { id: BOOKS, name: "Books" }, { id: TRANSPORT, name: "Transport" }];
    const csv = statementToCsv(buildStatement(i));
    expect(csv).toContain('"Tuition, ""special"""');
  });
});
