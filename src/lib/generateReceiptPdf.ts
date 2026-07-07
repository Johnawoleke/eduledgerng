import jsPDF from "jspdf";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);

interface ReceiptItem {
  name: string;
  amount: number;
}

interface ReceiptData {
  schoolName: string;
  studentName: string;
  studentId: string;
  studentClass: string;
  term: string;
  session: string;
  reference: string;
  date: string;
  method: string;
  totalPaid: number;
  items: ReceiptItem[];
  feesSummary?: {
    totalFees: number;
    totalPaid: number;
    totalOutstanding: number;
  };
}

/** Parse item strings that may contain "|amount" suffix */
export const parsePaymentItems = (items: string[] | null | undefined): ReceiptItem[] => {
  return (items || []).filter(Boolean).map((item) => {
    const pipeIdx = item.lastIndexOf("|");
    if (pipeIdx > 0) {
      const name = item.substring(0, pipeIdx);
      const amount = Number(item.substring(pipeIdx + 1));
      if (!isNaN(amount) && amount > 0) return { name, amount };
    }
    return { name: item, amount: 0 };
  });
};

export const generateReceiptPdf = (data: ReceiptData) => {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentW = pageW - margin * 2;
  let y = 20;

  // Brand colors
  const green: [number, number, number] = [0, 135, 81]; // #008751
  const dark: [number, number, number] = [30, 30, 30];
  const gray: [number, number, number] = [120, 120, 120];

  // Header bar
  doc.setFillColor(...green);
  doc.rect(0, 0, pageW, 12, "F");

  y = 22;

  // Logo text
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  // Measure "EduLedger" width to position "NG" right next to it
  doc.setTextColor(...dark);
  const eduText = "EduLedger";
  const ngText = "NG";
  const eduW = doc.getTextWidth(eduText);
  const ngW = doc.getTextWidth(ngText);
  const totalW = eduW + ngW;
  const startX = (pageW - totalW) / 2;
  doc.text(eduText, startX, y);
  doc.setTextColor(...green);
  doc.text(ngText, startX + eduW, y);
  y += 7;

  doc.setFontSize(10);
  doc.setTextColor(...gray);
  doc.text(data.schoolName, pageW / 2, y, { align: "center" });
  y += 5;

  doc.setFontSize(12);
  doc.setTextColor(...dark);
  doc.text("PAYMENT RECEIPT", pageW / 2, y, { align: "center" });
  y += 10;

  // Divider
  doc.setDrawColor(...green);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 8;

  // Student info
  const addRow = (label: string, value: string) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...gray);
    doc.text(label, margin, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...dark);
    doc.text(value, pageW - margin, y, { align: "right" });
    y += 6;
  };

  addRow("Student Name", data.studentName);
  addRow("Student ID", data.studentId);
  addRow("Class", data.studentClass);
  addRow("Term / Session", `${data.term} — ${data.session}`);
  y += 2;

  // Divider
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  // Transaction info
  addRow("Transaction Ref", data.reference);
  addRow("Date & Time", new Date(data.date).toLocaleString("en-NG", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit"
  }));
  addRow("Payment Method", data.method);
  y += 2;

  // Divider
  doc.line(margin, y, pageW - margin, y);
  y += 8;

  // Items table header
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...dark);
  doc.text("Fees Paid in This Transaction", margin, y);
  y += 7;

  doc.setFillColor(245, 245, 245);
  doc.rect(margin, y - 4, contentW, 7, "F");
  doc.setFontSize(9);
  doc.setTextColor(...gray);
  doc.text("Fee Item", margin + 2, y);
  doc.text("Amount", pageW - margin - 2, y, { align: "right" });
  y += 6;

  // Items
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...dark);
  data.items.forEach((item) => {
    doc.text(item.name, margin + 2, y);
    if (item.amount > 0) {
      doc.text(formatNaira(item.amount), pageW - margin - 2, y, { align: "right" });
    }
    y += 6;
  });

  y += 2;
  doc.setDrawColor(...green);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 7;

  // Total paid
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...dark);
  doc.text("Total Paid", margin, y);
  doc.setTextColor(...green);
  doc.text(formatNaira(data.totalPaid), pageW - margin, y, { align: "right" });
  y += 10;

  // Account summary
  if (data.feesSummary) {
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y);
    y += 7;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...dark);
    doc.text("Account Summary", pageW / 2, y, { align: "center" });
    y += 7;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...gray);
    doc.text("Total Fees", margin + 2, y);
    doc.setTextColor(...dark);
    doc.text(formatNaira(data.feesSummary.totalFees), pageW - margin - 2, y, { align: "right" });
    y += 5;

    doc.setTextColor(...gray);
    doc.text("Total Paid", margin + 2, y);
    doc.setTextColor(...green);
    doc.text(formatNaira(data.feesSummary.totalPaid), pageW - margin - 2, y, { align: "right" });
    y += 5;

    doc.setTextColor(...gray);
    doc.text("Outstanding", margin + 2, y);
    const outColor: [number, number, number] = data.feesSummary.totalOutstanding > 0 ? [220, 50, 50] : green;
    doc.setTextColor(...outColor);
    doc.setFont("helvetica", "bold");
    doc.text(formatNaira(data.feesSummary.totalOutstanding), pageW - margin - 2, y, { align: "right" });
    y += 10;
  }

  // Footer
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(...gray);
  doc.text("This is a computer-generated receipt and is valid without a signature.", pageW / 2, y, { align: "center" });
  y += 4;
  doc.text(`EduLedgerNG © ${new Date().getFullYear()}`, pageW / 2, y, { align: "center" });

  // Bottom bar
  doc.setFillColor(...green);
  doc.rect(0, doc.internal.pageSize.getHeight() - 6, pageW, 6, "F");

  // Save
  doc.save(`Receipt-${data.reference}.pdf`);
};
