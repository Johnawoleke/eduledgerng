

# EduLedgerNG — School Fee Payment App

A clean, professional school fee management app for Nigerian secondary schools (JSS1–SSS3) with green/white theming.

## Phase 1: Frontend Prototype (What we'll build now)

### 🔐 Login Page
- Student login with School ID + PIN
- Admin login with separate credentials
- Clean, branded login screen with EduLedgerNG logo and Nigerian green/white color scheme

### 🎓 Student Dashboard
- Welcome banner showing student name, class (JSS1–SSS3), and current term
- **Fee Summary Card** — total fees, amount paid, balance remaining
- **Fee Breakdown Table** — individual line items (tuition, lab fees, sports levy, books, uniform, etc.) with status per item
- **Payment History** — list of past payments with dates and amounts
- **Make Payment** — option to pay full balance or enter a custom installment amount
- Simulated Paystack payment flow (mock modal)

### 🧾 Receipt Generation
- After successful payment, generate a printable/downloadable receipt
- Shows school name, student details, payment amount, date, transaction reference, and breakdown of what was paid

### 📊 Admin Dashboard
- Overview cards: total students, total fees collected, outstanding balance
- **Payments Table** — searchable/filterable list of all payments (by student, class, date, status)
- **Student Directory** — view any student's fee status and payment history
- **Fee Management** — set fee amounts per class, per term, with ability to add custom amounts for individual students (scholarships/discounts)

### 🎨 Design
- Professional green (#008751) and white theme inspired by Nigerian colors
- Clean typography, card-based layout
- Mobile-responsive — works well on phones (important for Nigerian users)
- Subtle accents with gold/yellow for highlights

## Phase 2: Future Enhancements (not built now)
- Supabase backend with real authentication and data persistence
- Paystack integration for real payments
- SMS/email notifications for payment confirmations
- Bulk fee assignment and term management
- Export reports to CSV/PDF

