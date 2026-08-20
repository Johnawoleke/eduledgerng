// A student's full statement of account as a PDF.
//
// Unlike the receipt (one payment, always one page), this covers every year a
// student was enrolled, so it MUST paginate — a leaver with six years of termly
// fees runs to several pages. Every table draws through the same row writer,
// which breaks the page and repeats the column headers when it runs out of room.
import jsPDF from "jspdf";
import type { Statement } from "./studentStatement";

const naira = (n: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(n || 0);

export const generateStatementPdf = (s: Statement, save = true) => {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  const bottom = pageH - 20;
  let y = margin;

  const newPage = () => { doc.addPage(); y = margin; };
  const room = (needed: number) => { if (y + needed > bottom) newPage(); };

  const rule = () => {
    doc.setDrawColor(210);
    doc.line(margin, y, pageW - margin, y);
    y += 4;
  };

  // ---- header --------------------------------------------------------------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("EduLedgerNG", margin, y);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(s.school.name, pageW - margin, y, { align: "right" });
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("STATEMENT OF ACCOUNT", margin, y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(
    `Generated ${s.generatedAt.toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" })}`,
    margin, y
  );
  doc.setTextColor(0);
  y += 6;
  rule();

  // ---- student -------------------------------------------------------------
  const field = (label: string, value: string, x: number) => {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(label, x, y);
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.setFont("helvetica", "bold");
    doc.text(value || "—", x, y + 4.5);
    doc.setFont("helvetica", "normal");
  };
  field("STUDENT", s.student.name, margin);
  field("STUDENT ID", s.student.student_id, margin + 70);
  field("STATUS", s.student.status === "graduated" ? "Finished school" : (s.student.status || "Active"), margin + 130);
  y += 12;
  rule();

  // ---- summary -------------------------------------------------------------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Summary", margin, y);
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const summary: [string, string][] = [
    ["Total charged, all years", naira(s.totalCharged)],
    ["Total paid", naira(s.totalPaid)],
    ["Outstanding", naira(s.totalOutstanding)],
  ];
  for (const [label, value] of summary) {
    const owing = label === "Outstanding" && s.totalOutstanding > 0;
    doc.setFont("helvetica", owing ? "bold" : "normal");
    if (owing) doc.setTextColor(180, 30, 30);
    doc.text(label, margin, y);
    doc.text(value, pageW - margin, y, { align: "right" });
    doc.setTextColor(0);
    doc.setFont("helvetica", "normal");
    y += 5.5;
  }
  y += 3;

  // ---- per-year breakdown --------------------------------------------------
  const COLS = { term: margin, fee: margin + 26, charged: pageW - margin - 70, paid: pageW - margin - 36, out: pageW - margin };

  const columnHeader = () => {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("TERM", COLS.term, y);
    doc.text("FEE", COLS.fee, y);
    doc.text("CHARGED", COLS.charged, y, { align: "right" });
    doc.text("PAID", COLS.paid, y, { align: "right" });
    doc.text("OUTSTANDING", COLS.out, y, { align: "right" });
    doc.setTextColor(0);
    y += 4;
  };

  for (const p of s.periods) {
    room(30);
    y += 4;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(`${p.sessionName}  ·  ${p.className}`, margin, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(p.outcome, pageW - margin, y, { align: "right" });
    doc.setTextColor(0);
    y += 5;
    columnHeader();

    doc.setFontSize(9);
    for (const l of p.lines) {
      if (y + 6 > bottom) { newPage(); columnHeader(); doc.setFontSize(9); }
      doc.text(l.termName, COLS.term, y);
      doc.text(doc.splitTextToSize(l.feeName, 60)[0], COLS.fee, y);
      doc.text(naira(l.charged), COLS.charged, y, { align: "right" });
      doc.text(naira(l.paid), COLS.paid, y, { align: "right" });
      if (l.outstanding > 0) doc.setTextColor(180, 30, 30);
      doc.text(naira(l.outstanding), COLS.out, y, { align: "right" });
      doc.setTextColor(0);
      y += 5;
    }

    room(8);
    doc.setDrawColor(230);
    doc.line(COLS.charged - 24, y - 1, pageW - margin, y - 1);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("Year total", COLS.fee, y + 3);
    doc.text(naira(p.charged), COLS.charged, y + 3, { align: "right" });
    doc.text(naira(p.paid), COLS.paid, y + 3, { align: "right" });
    doc.text(naira(p.outstanding), COLS.out, y + 3, { align: "right" });
    doc.setFont("helvetica", "normal");
    y += 9;
  }

  if (s.periods.length === 0) {
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text("No fees have been charged to this student.", margin, y + 4);
    doc.setTextColor(0);
    y += 12;
  }

  // ---- payments ------------------------------------------------------------
  room(24);
  y += 4;
  rule();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Payments received", margin, y);
  y += 6;

  const payHeader = () => {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("DATE", margin, y);
    doc.text("REFERENCE", margin + 24, y);
    doc.text("METHOD", margin + 74, y);
    doc.text("COVERS", margin + 102, y);
    doc.text("AMOUNT", pageW - margin, y, { align: "right" });
    doc.setTextColor(0);
    y += 4;
  };
  payHeader();
  doc.setFontSize(9);

  for (const p of s.payments) {
    if (y + 6 > bottom) { newPage(); payHeader(); doc.setFontSize(9); }
    doc.text((p.date || "").slice(0, 10), margin, y);
    doc.text(doc.splitTextToSize(p.reference, 48)[0], margin + 24, y);
    doc.text(doc.splitTextToSize(p.method, 26)[0], margin + 74, y);
    doc.text(doc.splitTextToSize(p.covers.join(", ") || "—", 55)[0], margin + 102, y);
    doc.text(naira(p.amount), pageW - margin, y, { align: "right" });
    y += 5;
  }

  if (s.payments.length === 0) {
    doc.setTextColor(120);
    doc.text("No payments recorded.", margin, y);
    doc.setTextColor(0);
    y += 5;
  }

  // ---- footer on every page ------------------------------------------------
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(
      `${s.student.name} (${s.student.student_id}) · ${s.school.name}`,
      margin, pageH - 10
    );
    doc.text(`Page ${i} of ${pages}`, pageW - margin, pageH - 10, { align: "right" });
    doc.setTextColor(0);
  }

  const safe = s.student.student_id.replace(/[^A-Za-z0-9-]/g, "");
  // `save` is false only in tests, so the document can be inspected (page
  // count, in particular) without a download being triggered.
  if (save) doc.save(`statement-${safe || "student"}.pdf`);
  return doc;
};
