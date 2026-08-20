// A student's complete financial record, assembled for export.
//
// Schools need to hand a leaver — or an auditor, or a parent in a dispute — a
// statement of everything that was ever charged and everything that was ever
// paid. The dashboard shows one period at a time, which is the wrong shape for
// that question.
//
// Built from the LEDGER (student_charges), not by re-matching class_fees against
// the student's current class. A student who went Primary 1 to SSS3 has a
// different class in every row, and re-deriving would price all nine years
// against today's fee schedule. student_charges stores what was actually
// charged, so this reads history rather than recomputing it (20260818120000).
//
// Pure and synchronous: callers pass rows they already hold, so this is
// testable and adds no queries.

import { sumPaidForFee } from "./feeItems";

export interface StatementStudent {
  id: string;
  student_id: string;
  name: string;
  class?: string | null;
  status?: string | null;
  parent_email?: string | null;
}

export interface StatementSchool {
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface ChargeRow {
  class_fee_id: string;
  amount: number;
  session_id?: string | null;
  term_id?: string | null;
}

export interface PaymentRow {
  id?: string;
  reference?: string | null;
  date?: string | null;
  method?: string | null;
  amount?: number | null;
  items?: string[] | null;
  status?: string | null;
  session_id?: string | null;
  term_id?: string | null;
}

export interface EnrolmentRow {
  session_id: string;
  class: string;
  status?: string | null;
}

export interface NamedRow { id: string; name: string }
export interface TermRow { id: string; name: string; session_id?: string | null; term_number?: number | null }

export interface StatementInput {
  student: StatementStudent;
  school: StatementSchool;
  enrolments: EnrolmentRow[];
  charges: ChargeRow[];
  payments: PaymentRow[];
  fees: NamedRow[];
  sessions: NamedRow[];
  terms: TermRow[];
}

export interface StatementLine {
  feeId: string;
  feeName: string;
  termName: string;
  termNumber: number;
  charged: number;
  paid: number;
  outstanding: number;
}

export interface StatementPeriod {
  sessionId: string;
  sessionName: string;
  /** The class they were in THAT year, from the enrolment — not today's class. */
  className: string;
  /** What happened at the end of it: promoted / repeated / graduated / still active. */
  outcome: string;
  lines: StatementLine[];
  charged: number;
  paid: number;
  outstanding: number;
}

export interface StatementPayment {
  reference: string;
  date: string;
  method: string;
  amount: number;
  /** Fee names this payment settled, for the audit trail. */
  covers: string[];
}

export interface Statement {
  student: StatementStudent;
  school: StatementSchool;
  generatedAt: Date;
  periods: StatementPeriod[];
  payments: StatementPayment[];
  totalCharged: number;
  totalPaid: number;
  totalOutstanding: number;
}

/** Outcome stamped on the enrolment, in the words a school uses. */
const OUTCOME_TEXT: Record<string, string> = {
  active: "Currently enrolled",
  promoted: "Moved up",
  promoted_on_trial: "Moved up on trial",
  repeated: "Repeated the class",
  graduated: "Finished school",
};

const money = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};

export const buildStatement = (input: StatementInput): Statement => {
  const { student, school, enrolments, charges, payments, fees, sessions, terms } = input;

  const feeName = new Map(fees.map((f) => [f.id, f.name]));
  const sessionName = new Map(sessions.map((s) => [s.id, s.name]));
  const termById = new Map(terms.map((t) => [t.id, t]));
  const classBySession = new Map(enrolments.map((e) => [e.session_id, e.class]));
  const outcomeBySession = new Map(enrolments.map((e) => [e.session_id, e.status ?? "active"]));

  // Pending and failed attempts are recorded for the admin's visibility but
  // have not settled, so they must not reduce anything on a statement.
  const settled = (payments || []).filter(
    (p) => p.status !== "pending" && p.status !== "failed"
  );

  // Group charges by the session they belong to. student_charges is unique on
  // (student, class_fee), so each fee appears once and paid-per-fee is
  // unambiguous.
  const bySession = new Map<string, ChargeRow[]>();
  for (const c of charges || []) {
    const key = c.session_id ?? "";
    const list = bySession.get(key) || [];
    list.push(c);
    bySession.set(key, list);
  }

  const periods: StatementPeriod[] = [];
  for (const [sessionId, rows] of bySession) {
    const lines: StatementLine[] = rows.map((c) => {
      const name = feeName.get(c.class_fee_id) ?? "(fee no longer listed)";
      const charged = money(c.amount);
      // Matched by fee id; legacy payment lines with no id fall back to name.
      const paid = Math.min(sumPaidForFee(settled, { id: c.class_fee_id, name }), charged);
      const term = c.term_id ? termById.get(c.term_id) : undefined;
      return {
        feeId: c.class_fee_id,
        feeName: name,
        termName: term?.name ?? "No term",
        termNumber: term?.term_number ?? 99,
        charged,
        paid,
        outstanding: Math.max(charged - paid, 0),
      };
    });

    lines.sort((a, b) => a.termNumber - b.termNumber || a.feeName.localeCompare(b.feeName));

    periods.push({
      sessionId,
      sessionName: sessionName.get(sessionId) ?? "Unassigned period",
      className: classBySession.get(sessionId) ?? student.class ?? "—",
      outcome: OUTCOME_TEXT[outcomeBySession.get(sessionId) ?? "active"] ?? "Currently enrolled",
      lines,
      charged: lines.reduce((s, l) => s + l.charged, 0),
      paid: lines.reduce((s, l) => s + l.paid, 0),
      outstanding: lines.reduce((s, l) => s + l.outstanding, 0),
    });
  }

  // Oldest first — a statement reads as a history, not a feed.
  periods.sort((a, b) => a.sessionName.localeCompare(b.sessionName));

  const paymentRows: StatementPayment[] = settled
    .map((p) => ({
      reference: p.reference || "—",
      date: p.date || "",
      method: p.method || "—",
      amount: money(p.amount),
      covers: Array.from(
        new Set(
          (p.items || [])
            .map((raw) => {
              const pipe = raw.lastIndexOf("|");
              if (pipe <= 0) return null;
              const head = raw.substring(0, pipe);
              const uuid = /^[0-9a-f-]{36}\|([\s\S]*)$/i.exec(head);
              return uuid ? uuid[1] : head;
            })
            .filter((n): n is string => !!n)
        )
      ),
    }))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  return {
    student,
    school,
    generatedAt: new Date(),
    periods,
    payments: paymentRows,
    totalCharged: periods.reduce((s, p) => s + p.charged, 0),
    totalPaid: periods.reduce((s, p) => s + p.paid, 0),
    totalOutstanding: periods.reduce((s, p) => s + p.outstanding, 0),
  };
};

/** The statement as CSV, for a school that wants it in a spreadsheet. */
export const statementToCsv = (s: Statement): string => {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows: string[] = [];

  rows.push(esc(`Statement of account — ${s.student.name} (${s.student.student_id})`));
  rows.push(esc(s.school.name));
  rows.push(esc(`Generated ${s.generatedAt.toISOString().slice(0, 10)}`));
  rows.push("");

  rows.push(["Session", "Class", "Outcome", "Term", "Fee", "Charged", "Paid", "Outstanding"].map(esc).join(","));
  for (const p of s.periods) {
    for (const l of p.lines) {
      rows.push([p.sessionName, p.className, p.outcome, l.termName, l.feeName, l.charged, l.paid, l.outstanding].map(esc).join(","));
    }
  }

  rows.push("");
  rows.push(["Total charged", s.totalCharged].map(esc).join(","));
  rows.push(["Total paid", s.totalPaid].map(esc).join(","));
  rows.push(["Outstanding", s.totalOutstanding].map(esc).join(","));

  rows.push("");
  rows.push(["Payment date", "Reference", "Method", "Amount", "Covers"].map(esc).join(","));
  for (const p of s.payments) {
    rows.push([p.date?.slice(0, 10) ?? "", p.reference, p.method, p.amount, p.covers.join("; ")].map(esc).join(","));
  }

  return rows.join("\n");
};
