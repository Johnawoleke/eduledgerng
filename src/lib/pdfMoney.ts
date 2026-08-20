// Money formatting for PDFs.
//
// jsPDF's built-in fonts (Helvetica and friends) are WinAnsi/latin-1 encoded.
// The naira sign is U+20A6, outside that range, so `₦` renders as a stray `¦`
// and the amount reads as garbage. Every receipt the platform has issued has
// had this — it is invisible on screen because the dashboard uses real fonts,
// and only appears in the generated PDF.
//
// The fix is not to embed a Unicode font: the smallest one carrying ₦ is over
// 100KB, on a bundle that is already 1.1MB, to draw a single character. "NGN"
// is standard on Nigerian financial documents, unambiguous, and encodes.
//
// On-screen formatting keeps the ₦ symbol — use formatNaira in the components.
export const pdfMoney = (amount: number): string =>
  `NGN ${new Intl.NumberFormat("en-NG", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(Math.round(amount || 0))}`;
