export interface Student {
  id: string;
  name: string;
  class: string;
  term: string;
  session: string;
  pin: string;
}

export interface FeeItem {
  id: string;
  name: string;
  amount: number;
  paid: number;
  status: "paid" | "partial" | "unpaid";
}

export interface Payment {
  id: string;
  studentId: string;
  studentName: string;
  class: string;
  amount: number;
  date: string;
  reference: string;
  method: string;
  items: string[];
}

export const students: Student[] = [
  { id: "EDU/2024/001", name: "Adebayo Oluwaseun", class: "SSS2", term: "2nd Term", session: "2024/2025", pin: "1234" },
  { id: "EDU/2024/002", name: "Chinwe Okafor", class: "JSS3", term: "2nd Term", session: "2024/2025", pin: "1234" },
  { id: "EDU/2024/003", name: "Ibrahim Musa", class: "SSS1", term: "2nd Term", session: "2024/2025", pin: "1234" },
  { id: "EDU/2024/004", name: "Fatima Bello", class: "JSS1", term: "2nd Term", session: "2024/2025", pin: "1234" },
  { id: "EDU/2024/005", name: "Emeka Nwosu", class: "SSS3", term: "2nd Term", session: "2024/2025", pin: "1234" },
];

export const feeStructure: Record<string, FeeItem[]> = {
  "EDU/2024/001": [
    { id: "1", name: "Tuition Fee", amount: 75000, paid: 75000, status: "paid" },
    { id: "2", name: "Laboratory Fee", amount: 15000, paid: 0, status: "unpaid" },
    { id: "3", name: "Sports Levy", amount: 5000, paid: 5000, status: "paid" },
    { id: "4", name: "Books & Materials", amount: 20000, paid: 10000, status: "partial" },
    { id: "5", name: "Uniform", amount: 12000, paid: 0, status: "unpaid" },
    { id: "6", name: "ICT Fee", amount: 10000, paid: 10000, status: "paid" },
  ],
  "EDU/2024/002": [
    { id: "1", name: "Tuition Fee", amount: 60000, paid: 60000, status: "paid" },
    { id: "2", name: "Laboratory Fee", amount: 10000, paid: 10000, status: "paid" },
    { id: "3", name: "Sports Levy", amount: 5000, paid: 0, status: "unpaid" },
    { id: "4", name: "Books & Materials", amount: 15000, paid: 15000, status: "paid" },
    { id: "5", name: "Uniform", amount: 10000, paid: 10000, status: "paid" },
  ],
  "EDU/2024/003": [
    { id: "1", name: "Tuition Fee", amount: 70000, paid: 35000, status: "partial" },
    { id: "2", name: "Laboratory Fee", amount: 12000, paid: 0, status: "unpaid" },
    { id: "3", name: "Sports Levy", amount: 5000, paid: 0, status: "unpaid" },
    { id: "4", name: "Books & Materials", amount: 18000, paid: 0, status: "unpaid" },
    { id: "5", name: "ICT Fee", amount: 10000, paid: 0, status: "unpaid" },
  ],
  "EDU/2024/004": [
    { id: "1", name: "Tuition Fee", amount: 50000, paid: 0, status: "unpaid" },
    { id: "2", name: "Sports Levy", amount: 5000, paid: 0, status: "unpaid" },
    { id: "3", name: "Books & Materials", amount: 12000, paid: 0, status: "unpaid" },
    { id: "4", name: "Uniform", amount: 10000, paid: 0, status: "unpaid" },
  ],
  "EDU/2024/005": [
    { id: "1", name: "Tuition Fee", amount: 80000, paid: 80000, status: "paid" },
    { id: "2", name: "Laboratory Fee", amount: 15000, paid: 15000, status: "paid" },
    { id: "3", name: "Sports Levy", amount: 5000, paid: 5000, status: "paid" },
    { id: "4", name: "Books & Materials", amount: 22000, paid: 22000, status: "paid" },
    { id: "5", name: "Uniform", amount: 12000, paid: 12000, status: "paid" },
    { id: "6", name: "ICT Fee", amount: 10000, paid: 10000, status: "paid" },
    { id: "7", name: "WAEC/NECO Fee", amount: 25000, paid: 25000, status: "paid" },
  ],
};

export const payments: Payment[] = [
  { id: "PAY001", studentId: "EDU/2024/001", studentName: "Adebayo Oluwaseun", class: "SSS2", amount: 75000, date: "2025-01-15", reference: "PSK-2025-A1B2C3", method: "Paystack", items: ["Tuition Fee"] },
  { id: "PAY002", studentId: "EDU/2024/001", studentName: "Adebayo Oluwaseun", class: "SSS2", amount: 5000, date: "2025-01-20", reference: "PSK-2025-D4E5F6", method: "Paystack", items: ["Sports Levy"] },
  { id: "PAY003", studentId: "EDU/2024/001", studentName: "Adebayo Oluwaseun", class: "SSS2", amount: 10000, date: "2025-02-01", reference: "PSK-2025-G7H8I9", method: "Paystack", items: ["Books & Materials (partial)", "ICT Fee"] },
  { id: "PAY004", studentId: "EDU/2024/002", studentName: "Chinwe Okafor", class: "JSS3", amount: 95000, date: "2025-01-10", reference: "PSK-2025-J1K2L3", method: "Paystack", items: ["Tuition Fee", "Laboratory Fee", "Books & Materials", "Uniform"] },
  { id: "PAY005", studentId: "EDU/2024/003", studentName: "Ibrahim Musa", class: "SSS1", amount: 35000, date: "2025-01-25", reference: "PSK-2025-M4N5O6", method: "Paystack", items: ["Tuition Fee (partial)"] },
  { id: "PAY006", studentId: "EDU/2024/005", studentName: "Emeka Nwosu", class: "SSS3", amount: 169000, date: "2025-01-05", reference: "PSK-2025-P7Q8R9", method: "Paystack", items: ["All Fees"] },
];

export const classes = ["JSS1", "JSS2", "JSS3", "SSS1", "SSS2", "SSS3"];

export const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);
