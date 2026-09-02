// Login slips a school can print, cut up and send home in schoolbags.
//
// After a roster upload the credentials exist in exactly one place: a CSV of
// id + temporary password. A school with 300 pupils then has to get 300 rows to
// 300 parents by hand, and a spreadsheet is not a thing you can hand a child.
//
// Email covers the parents who gave an address. Many will not have — the
// roster template marks parent_email optional precisely because schools often
// do not hold one — and for a Nigerian primary school a slip in the bag is
// more reliably delivered than an email anyway.
//
// So: an A4 page of six cut-out slips, each naming one pupil, their id, their
// temporary password and the school's portal link.
//
// The password is printed in clear. That is the point of a one-time credential
// handed over physically, and it is the same exposure the CSV already has —
// but it means these pages are sensitive until they are distributed, and the
// footer says so.
import jsPDF from "jspdf";

export interface CredentialSlip {
  studentId: string;
  name: string;
  className: string;
  tempPassword: string;
}

export interface SlipOptions {
  schoolName: string;
  portalUrl: string;
}

// Two columns, three rows. Bigger than a business card because a parent has to
// read it and type it, often from a phone, often in poor light.
const COLS = 2;
const ROWS = 3;
const MARGIN = 10;

export const generateCredentialSlips = (
  slips: CredentialSlip[],
  { schoolName, portalUrl }: SlipOptions
): jsPDF => {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const cellW = (pageW - MARGIN * 2) / COLS;
  const cellH = (pageH - MARGIN * 2) / ROWS;
  const perPage = COLS * ROWS;

  slips.forEach((slip, i) => {
    if (i > 0 && i % perPage === 0) doc.addPage();
    const idx = i % perPage;
    const x = MARGIN + (idx % COLS) * cellW;
    const y = MARGIN + Math.floor(idx / COLS) * cellH;

    // A cut line, so a school knows where scissors go.
    doc.setDrawColor(200);
    doc.setLineDashPattern([1, 1], 0);
    doc.rect(x, y, cellW, cellH);
    doc.setLineDashPattern([], 0);

    const pad = 6;
    let cursor = y + pad + 4;

    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(doc.splitTextToSize(schoolName, cellW - pad * 2)[0] || "", x + pad, cursor);

    cursor += 7;
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.setFont("helvetica", "bold");
    doc.text(doc.splitTextToSize(slip.name, cellW - pad * 2)[0] || "", x + pad, cursor);

    cursor += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(110);
    doc.text(slip.className || "", x + pad, cursor);

    // The two things the parent actually needs, given the most room.
    cursor += 9;
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text("Student ID", x + pad, cursor);
    cursor += 6;
    doc.setFontSize(14);
    doc.setFont("courier", "bold");
    doc.setTextColor(20);
    doc.text(slip.studentId, x + pad, cursor);

    cursor += 8;
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(110);
    doc.text("First-time password", x + pad, cursor);
    cursor += 6;
    doc.setFontSize(14);
    doc.setFont("courier", "bold");
    doc.setTextColor(20);
    doc.text(slip.tempPassword, x + pad, cursor);

    cursor += 9;
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(110);
    // Wrapped, because a school's domain plus slug overruns a slip easily.
    for (const line of doc.splitTextToSize(portalUrl, cellW - pad * 2).slice(0, 2)) {
      doc.text(line, x + pad, cursor);
      cursor += 4;
    }

    cursor += 2;
    doc.setFontSize(7);
    doc.text("You will be asked to change this password on first login.",
      x + pad, cursor, { maxWidth: cellW - pad * 2 });
  });

  // Said once per page, because a stack of these left on a desk is every
  // pupil's login sitting in the open.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(150);
    doc.text(
      "Contains passwords. Hand out promptly and do not leave lying around.",
      MARGIN, pageH - 4
    );
  }

  return doc;
};

/** How many A4 sheets a school is about to print. */
export const slipPageCount = (count: number): number =>
  Math.max(1, Math.ceil(Math.max(count, 0) / (COLS * ROWS)));
