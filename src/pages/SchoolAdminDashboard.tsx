// src/pages/SchoolAdminDashboard.tsx
import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  LogOut,
  Users, 
  Wallet, 
  TrendingUp, 
  Search, 
  Plus, 
  UserPlus, 
  Copy, 
  Link as LinkIcon, 
  KeyRound, 
  Trash2, 
  ChevronLeft, 
  Download, 
  Settings, 
  Upload,
  Home,
  UserCog,
  Eye,
  EyeOff,
  Mail,
  Loader2,
  FileSpreadsheet,
  Archive,
  ArchiveRestore,
  ChevronsUp
} from "lucide-react";
import { generateReceiptPdf, parsePaymentItems } from "@/lib/generateReceiptPdf";
import { isSettledPayment } from "@/lib/paymentStatus";
import { NIGERIAN_CLASSES } from "@/lib/classes";
import { createSessionWithTerms } from "@/lib/academicSessions";
import { sumPaidForFee, countStudentsInClass as countInClass } from "@/lib/fees";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionsError } from "@/lib/utils";
import { useAcademicPeriods } from "@/hooks/useAcademicPeriods";
import AcademicPeriodSelector from "@/components/AcademicPeriodSelector";
import NotificationBell from "@/components/NotificationBell";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);

// Full private-school range: Nursery, Primary, Junior and Senior Secondary.
// The JSS/SSS values are unchanged so existing students and fees keep matching.
// The default credential a student receives on creation/reset. MUST be the same
// everywhere (create, bulk upload, reset, and the messages shown to the owner) —
// a mismatch locks the student out of first login.
// Every student used to be created with the literal password "password". Since
// student IDs are a guessable INITIALS-NNNN code, that made any account whose
// holder hadn't logged in yet a one-request takeover. Initial passwords are now
// random per student: the owner reads it off the dashboard once and hands it
// over, and the student is forced to replace it on first login.
//
// Ambiguous glyphs (0/O, 1/l/I) are excluded because these get copied by hand
// off a screen and read aloud in a classroom.
const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

const generateTempPassword = (length = 10): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // Reject-free modulo bias is irrelevant at this alphabet size, but keep the
  // alphabet length a clean divisor-free pick and draw plenty of entropy:
  // 55^10 ≈ 2.5e17 possibilities.
  return Array.from(bytes, (b) => TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length]).join("");
};

const DEFAULT_FEE_TEMPLATES = [
  "Tuition Fee", "PTA Levy", "Exam Fee", "Sports Levy", "Computer Fee",
  "Library Fee", "Laboratory Fee", "Books and Materials", "Uniform Fee", "Development Levy",
];

interface StudentRow {
  id: string;
  student_id: string;
  name: string;
  class: string;
  term: string;
  session: string;
  default_pin: string | null;
  must_change_pin: boolean;
  parent_email: string | null;
  status: string;
  totalFees: number;
  totalPaid: number;
}

interface ClassFee {
  id: string;
  school_id: string;
  class_target: string;
  name: string;
  amount: number;
  session_id: string | null;
  term_id: string | null;
  status: string;
  created_at?: string;
}

// What promote-session returns from a preview. Mirrors the Plan/summary shape
// in supabase/functions/promote-session/index.ts.
interface PromotionPlan {
  student_id: string;
  student_code: string;
  name: string;
  from_class: string;
  action: "promote" | "graduate" | "unknown";
  to_class: string | null;
  reason: string;
  outstanding: number;
  already_enrolled: boolean;
}

interface PromotionPreview {
  summary: {
    from_session: string;
    to_session: string;
    highest_class_in_use: string | null;
    total: number;
    promoting: number;
    graduating: number;
    unknown_class: number;
    owing: number;
    owing_total: number;
    already_done: number;
  };
  plans: PromotionPlan[];
}

// A row of the fee ledger: what one student was actually charged for one fee.
// Written by trigger when the fee is published (migration 20260818120000), and
// never recomputed, so it stays correct after a student changes class.
interface StudentCharge {
  student_id: string;
  class_fee_id: string;
  amount: number;
  session_id: string | null;
  term_id: string | null;
}

const generateStudentCode = (surname: string, firstName: string, middleName: string) => {
  const initials = [surname, firstName, middleName]
    .filter(Boolean)
    .map((n) => n.charAt(0).toUpperCase())
    .join("");
  const num = String(Math.floor(1000 + Math.random() * 9000));
  return `${initials}-${num}`;
};

const normalizeHeader = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");

const parseCsvRows = (text: string): Record<string, string>[] => {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      currentCell += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i += 1;
      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell.length > 0)) rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell.trim());
  if (currentRow.some((cell) => cell.length > 0)) rows.push(currentRow);
  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => normalizeHeader(h));
  return rows.slice(1).map((row) => {
    const item: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (header) item[header] = row[idx]?.trim() || "";
    });
    return item;
  });
};

const SchoolAdminDashboard = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [school, setSchool] = useState<any>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [approvingFeeId, setApprovingFeeId] = useState<string | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [classFees, setClassFees] = useState<ClassFee[]>([]);
  const [charges, setCharges] = useState<StudentCharge[]>([]);
  // Year-end rollover. preview is computed server-side and reviewed here before
  // anything is committed — see supabase/functions/promote-session.
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<string>("");
  const [promotePreview, setPromotePreview] = useState<PromotionPreview | null>(null);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [classEditFor, setClassEditFor] = useState<string | null>(null);
  const [classEditBusy, setClassEditBusy] = useState(false);
  const [payments, setPayments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [studentsClassFilter, setStudentsClassFilter] = useState("JSS1");
  const [showArchived, setShowArchived] = useState(false);
  const [paymentsClassFilter, setPaymentsClassFilter] = useState("ALL");
  const [selectedStudent, setSelectedStudent] = useState<StudentRow | null>(null);
  const [studentFees, setStudentFees] = useState<any[]>([]);
  const [loadingFees, setLoadingFees] = useState(false);

  // Add student dialog
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [newSurname, setNewSurname] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newMiddleName, setNewMiddleName] = useState("");
  const [newStudentClass, setNewStudentClass] = useState("");
  const [newParentEmail, setNewParentEmail] = useState("");
  const [addingStudent, setAddingStudent] = useState(false);
  const [uploadingStudents, setUploadingStudents] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Add fee dialog (owners and bursars; new fees require owner approval)
  const [addFeeOpen, setAddFeeOpen] = useState(false);
  const [feeClass, setFeeClass] = useState("");
  const [feeEntries, setFeeEntries] = useState<{ name: string; amount: string; locked?: boolean }[]>(
    DEFAULT_FEE_TEMPLATES.map((name) => ({ name, amount: "" }))
  );
  const [addingFee, setAddingFee] = useState(false);
  const [feeSessionId, setFeeSessionId] = useState("");
  const [feeTermId, setFeeTermId] = useState("");
  const [loadingExistingFees, setLoadingExistingFees] = useState(false);
  const [hasExistingFees, setHasExistingFees] = useState(false);

  // Add Bursar dialog (only for owners)
  const [addBursarOpen, setAddBursarOpen] = useState(false);
  const [bursarEmail, setBursarEmail] = useState("");
  const [bursarFullName, setBursarFullName] = useState("");
  const [bursarPassword, setBursarPassword] = useState("");
  const [bursarConfirmPassword, setBursarConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [addingBursar, setAddingBursar] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<{ email: string; password: string } | null>(null);

  // Staff management (owner only): current members. Bursars are added only by the
  // owner creating a new account for them — there is no invitation flow.
  const [staffMembers, setStaffMembers] = useState<{ user_id: string; role: string; email: string }[]>([]);
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [staffActionId, setStaffActionId] = useState<string | null>(null);

  const loadStaff = async () => {
    if (!school?.id) return;
    setLoadingStaff(true);
    try {
      const { data: admins } = await supabase
        .from("school_admins")
        .select("user_id, role")
        .eq("school_id", school.id);

      const userIds = (admins || []).map((a) => a.user_id);
      const emailById: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, email")
          .in("id", userIds);
        (profs || []).forEach((p) => { emailById[p.id] = p.email || ""; });
      }

      // The owner's own profiles row can be missing/empty (no readable email),
      // which showed the owner's row as "—". Fill their own address from the
      // authenticated session so at least the current user always sees theirs.
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (currentUser?.id && currentUser.email && !emailById[currentUser.id]) {
        emailById[currentUser.id] = currentUser.email;
      }

      setStaffMembers(
        (admins || []).map((a) => ({ user_id: a.user_id, role: a.role, email: emailById[a.user_id] || "—" }))
      );
    } finally {
      setLoadingStaff(false);
    }
  };

  const handleRemoveBursar = async (userId: string, email: string) => {
    if (!confirm(`Remove ${email} from this school? They will lose access immediately.`)) return;
    setStaffActionId(userId);
    try {
      const { data, error } = await supabase.functions.invoke("remove-bursar", {
        body: { schoolId: school.id, userId },
      });
      if (error || data?.error) {
        toast.error(data?.error || (await readFunctionsError(error, "Failed to remove staff")));
      } else {
        toast.success(`${email} removed`);
        loadStaff();
      }
    } finally {
      setStaffActionId(null);
    }
  };

  const academicPeriods = useAcademicPeriods(school?.id);

  // Set fee dialog defaults to match dashboard selection
  useEffect(() => {
    if (academicPeriods.selectedSessionId && !feeSessionId) {
      setFeeSessionId(academicPeriods.selectedSessionId);
    }
    if (academicPeriods.selectedTermId && !feeTermId) {
      setFeeTermId(academicPeriods.selectedTermId);
    }
  }, [academicPeriods.selectedSessionId, academicPeriods.selectedTermId]);

  // Update fee term dropdown when fee session changes. Keep a still-valid
  // selection, then prefer the term currently selected on the dashboard so
  // submitted fees land where the Fees tab is looking, then fall back to Term 1.
  useEffect(() => {
    if (!feeSessionId) return;
    const sessionTerms = academicPeriods.terms.filter((t) => t.session_id === feeSessionId);
    if (sessionTerms.some((t) => t.id === feeTermId)) return;
    const dashboardTerm = sessionTerms.find((t) => t.id === academicPeriods.selectedTermId);
    const fallback = dashboardTerm || sessionTerms.find((t) => t.name === "Term 1") || sessionTerms[0];
    if (fallback) setFeeTermId(fallback.id);
  }, [feeSessionId, feeTermId, academicPeriods.terms, academicPeriods.selectedTermId]);

  // Fetch existing fees when session, term, and class are selected. Keyed on
  // addFeeOpen too, so reopening the dialog always refetches — otherwise a fee
  // approved/rejected in the Fees tab in between would leave stale locked
  // flags and amounts in the form.
  useEffect(() => {
    const fetchExistingFees = async () => {
      if (!addFeeOpen || !feeSessionId || !feeTermId || !feeClass || !school?.id) {
        setHasExistingFees(false);
        return;
      }

      setLoadingExistingFees(true);
      try {
        const { data, error } = await supabase
          .from("class_fees")
          .select("*")
          .eq("school_id", school.id)
          .eq("class_target", feeClass)
          .eq("session_id", feeSessionId)
          .eq("term_id", feeTermId);

        if (error) {
          console.error("Error fetching existing fees:", error);
          setHasExistingFees(false);
          return;
        }

        if (data && data.length > 0) {
          const populated = DEFAULT_FEE_TEMPLATES.map((template) => {
            const existing = data.find((f) => f.name === template);
            return {
              name: template,
              amount: existing ? String(existing.amount) : "",
              // Published fees are locked for the entire session
              locked: existing?.status === "published",
            };
          });
          setFeeEntries(populated);
          setHasExistingFees(true);
        } else {
          setFeeEntries(DEFAULT_FEE_TEMPLATES.map((name) => ({ name, amount: "" })));
          setHasExistingFees(false);
        }
      } catch (error) {
        console.error("Error fetching fees:", error);
        setHasExistingFees(false);
      } finally {
        setLoadingExistingFees(false);
      }
    };

    fetchExistingFees();
  }, [addFeeOpen, feeSessionId, feeTermId, feeClass, school?.id]);

  // Filter fees by selected term. Future (virtual) sessions have no data by
  // definition — show a blank dashboard rather than leaking current-term data.
  const filteredClassFees = academicPeriods.isFutureSession
    ? []
    : classFees.filter((f) => {
        if (!academicPeriods.selectedTermId) return true;
        return f.term_id === academicPeriods.selectedTermId;
      });

  // Only PUBLISHED fees count toward what students owe
  const publishedClassFees = filteredClassFees.filter((f) => f.status === "published");

  // The Fees tab and pending badge cover the whole selected SESSION (all
  // terms), so a pending fee submitted for another term is never invisible.
  const sessionClassFees = academicPeriods.isFutureSession
    ? []
    : classFees.filter(
        (f) => !academicPeriods.selectedSessionId || f.session_id === academicPeriods.selectedSessionId
      );
  const pendingFeesCount = sessionClassFees.filter((f) => f.status === "pending").length;

  // Filter payments by selected term only (ALL statuses — the Payments tab
  // shows pending/failed attempts too, with a status badge).
  const filteredPaymentsByPeriod = academicPeriods.isFutureSession
    ? []
    : payments.filter((p) => {
        if (!academicPeriods.selectedTermId) return true;
        return p.term_id === academicPeriods.selectedTermId;
      });

  // Only SETTLED payments count toward balances and collection stats. Pending
  // and failed Paystack attempts are visible in the list but never reduce an
  // outstanding balance. Legacy rows have no status -> treated as settled.
  const settledPaymentsByPeriod = filteredPaymentsByPeriod.filter(isSettledPayment);

  // Every settled payment, deliberately NOT scoped to the selected period. A
  // charge is credited by fee id, so a payment that cleared an old term's debt
  // has to count toward that charge whichever period its row is stamped with.
  const allSettledPayments = payments.filter(isSettledPayment);

  const feeById = new Map(classFees.map((f) => [f.id, f]));

  // What a specific student was CHARGED in the selected term, from the ledger.
  // Replaces matching class_fees against the student's CURRENT class, which
  // recomputed history on every read and is why a promoted student's old
  // balance would have been evaluated against their new class's fees.
  const getChargedFees = (studentId: string) =>
    (academicPeriods.isFutureSession
      ? []
      : charges.filter(
          (c) =>
            c.student_id === studentId &&
            (!academicPeriods.selectedTermId || c.term_id === academicPeriods.selectedTermId)
        )
    ).map((c) => ({
      id: c.class_fee_id,
      name: feeById.get(c.class_fee_id)?.name ?? "Fee",
      amount: Number(c.amount),
      session_id: c.session_id,
      term_id: c.term_id,
    }));

  // Helper: calculate paid amount for a fee.
  // Matched by fee id where the payment recorded one, falling back to name for
  // rows written before the ledger carried ids. Name-only matching silently
  // cross-credited two fees that shared a name in the same period.
  const getPaidForFee = (studentId: string, fee: { id: string; name: string }, feeAmount: number) => {
    const forStudent = allSettledPayments.filter((p) => p.student_id === studentId);
    return Math.min(sumPaidForFee(forStudent, fee), feeAmount);
  };

  const loadData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      navigate(`/school/${slug}`);
      return;
    }
    setUserId(user.id);

    // A freshly-created bursar must replace the owner-set temp password before
    // using the app — enforce it here too (not just on /main-dashboard).
    const { data: prof } = await supabase
      .from("profiles")
      .select("must_change_password")
      .eq("id", user.id)
      .maybeSingle();
    if (prof?.must_change_password) {
      navigate("/change-password");
      return;
    }

    const { data: schoolData } = await supabase
      .from("schools")
      .select("*")
      .eq("slug", slug!)
      .maybeSingle();

    if (!schoolData) {
      navigate(`/school/${slug}`);
      return;
    }

    setSchool(schoolData);

    // Fetch user's role for this school.
    //
    // This is a membership CHECK, not just a role lookup: a signed-in user who
    // is neither the owner nor in school_admins has no business on this page.
    // Previously a null role just rendered a read-only dashboard, and since the
    // payments table was world-readable that leaked another school's entire
    // payment history to anyone with an account. RLS is the real boundary now,
    // but the page must not pretend to be an admin view either.
    const { data: adminEntry } = await supabase
      .from("school_admins")
      .select("role")
      .eq("school_id", schoolData.id)
      .eq("user_id", user.id)
      .maybeSingle();

    const role = adminEntry?.role || (schoolData.owner_id === user.id ? "owner" : null);
    if (!role) {
      toast.error("You do not have access to this school");
      navigate(`/school/${slug}`);
      return;
    }
    setUserRole(role);

    // Fetch all students but filter to only active ones
    const { data: studentsData } = await supabase
      .from("students")
      .select("id, student_id, name, class, term, session, default_pin, must_change_pin, parent_email, status")
      .eq("school_id", schoolData.id);

    // Fetch class fees for the selected term
    const { data: classFeesData } = await supabase
      .from("class_fees")
      .select("*")
      .eq("school_id", schoolData.id);

    // Fetch payments for the selected term
    const { data: paymentsData } = await supabase
      .from("payments")
      .select("*, students(name, student_id, class)")
      .eq("school_id", schoolData.id)
      .order("date", { ascending: false });

    // What each student was actually CHARGED. Balances come from here rather
    // than from re-matching class_fees against a student's current class, so a
    // promoted student's history stays correct (migration 20260818120000).
    const { data: chargesData } = await supabase
      .from("student_charges")
      .select("student_id, class_fee_id, amount, session_id, term_id")
      .eq("school_id", schoolData.id);

    const allClassFees = (classFeesData || []) as ClassFee[];
    setClassFees(allClassFees);
    setPayments(paymentsData || []);
    setCharges((chargesData || []) as StudentCharge[]);

    // Keep ALL students (active + archived); the roster filters by status in
    // the render so archived students can be viewed and restored.
    const studentRows: StudentRow[] = (studentsData || [])
      .map((s: any) => {
        return { ...s, totalFees: 0, totalPaid: 0 };
      });

    studentRows.sort((a, b) => a.name.localeCompare(b.name));
    setStudents(studentRows);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [slug]);

  const isArchived = (s: StudentRow) => s.status === "archived" || s.status === "inactive";
  const activeStudents = students.filter((s) => !isArchived(s));
  const archivedStudents = students.filter((s) => isArchived(s));

  // How many active students a fee applies to (a fee targets one class, or ALL).
  // A fee that applies to 0 students shows "Published" but adds nothing to any
  // balance until a student is added to that class — this makes that visible.
  const countStudentsInClass = (classTarget: string) => countInClass(activeStudents, classTarget);

  // Recalculate student totals when period filter changes (term-specific).
  // Only ACTIVE students count toward the roster and stats.
  // What each student owes across EVERY period, not just the one on screen.
  // This is the number a school actually chases: the dashboard shows one term
  // at a time, so a debt carried from an earlier term is otherwise invisible.
  const owingAllPeriods = (() => {
    const out = new Map<string, number>();
    for (const c of charges) {
      const forStudent = allSettledPayments.filter((p) => p.student_id === c.student_id);
      // The fee NAME matters: legacy payment lines carry no fee id and match by
      // name. Passing a blank one reads every one of them as unpaid.
      const paid = Math.min(
        sumPaidForFee(forStudent, {
          id: c.class_fee_id,
          name: feeById.get(c.class_fee_id)?.name ?? "",
        }),
        Number(c.amount)
      );
      out.set(
        c.student_id,
        (out.get(c.student_id) || 0) + Math.max(Number(c.amount) - paid, 0)
      );
    }
    return out;
  })();

  const debtorCount = activeStudents.filter((s) => (owingAllPeriods.get(s.id) || 0) > 0).length;
  const owingGrandTotal = activeStudents.reduce((a, s) => a + (owingAllPeriods.get(s.id) || 0), 0);

  const studentsWithTotals = activeStudents.map((s) => {
    const applicableFees = getChargedFees(s.id);
    const totalFees = applicableFees.reduce((a, f) => a + Number(f.amount), 0);

    // Summed per fee, not by adding up whole payment rows. The old version
    // credited the full payment amount against this term's fees, which double
    // counted a payment that had covered several fees or another period.
    const totalPaid = applicableFees.reduce(
      (a, f) => a + getPaidForFee(s.id, f, Number(f.amount)),
      0
    );

    return { ...s, totalFees, totalPaid: Math.min(totalPaid, totalFees) };
  });

  // --- Year-end rollover ---------------------------------------------------
  //
  // The target session must be a REAL row: the picker also offers virtual
  // "future-<year>" sessions, which are not UUIDs and would 22P02 every query
  // in the function. If one is chosen, create it for real first.
  const resolveTargetSession = async (chosen: string): Promise<string | null> => {
    if (!chosen.startsWith("future-")) return chosen;
    const opt = academicPeriods.sessionOptions.find((o) => o.id === chosen);
    if (!school || !opt) return null;
    const { session, error } = await createSessionWithTerms(school.id, opt.name);
    if (error || !session) {
      toast.error(error || `Could not create the ${opt.name} session.`);
      return null;
    }
    await academicPeriods.reload();
    return session.id;
  };

  const runPromotion = async (mode: "preview" | "commit") => {
    if (!school || !academicPeriods.selectedSessionId) return;
    if (academicPeriods.isFutureSession) {
      toast.error("Switch to the session you are promoting FROM first.");
      return;
    }
    if (!promoteTarget) {
      toast.error("Choose the session to promote students into.");
      return;
    }
    setPromoteBusy(true);
    try {
      const targetId = await resolveTargetSession(promoteTarget);
      if (!targetId) return;

      const { data, error } = await supabase.functions.invoke("promote-session", {
        body: {
          school_id: school.id,
          from_session_id: academicPeriods.selectedSessionId,
          to_session_id: targetId,
          mode,
        },
      });
      const message = error || data?.error
        ? data?.error || (await readFunctionsError(error, "Something went wrong"))
        : null;
      if (message) {
        toast.error(message);
        return;
      }
      if (mode === "preview") {
        setPromoteTarget(targetId);
        setPromotePreview(data);
      } else {
        const a = data.applied;
        toast.success(
          `Promoted ${a.marked_promoted}, graduated ${a.marked_graduated}.` +
            (a.left_alone_unknown_class
              ? ` ${a.left_alone_unknown_class} left alone (class not recognised).`
              : "")
        );
        setPromoteOpen(false);
        setPromotePreview(null);
        await academicPeriods.reload();
        loadData();
      }
    } finally {
      setPromoteBusy(false);
    }
  };

  // --- Correct one student's class ------------------------------------------
  const handleChangeClass = async (studentDbId: string, newClass: string) => {
    if (!school || !academicPeriods.selectedSessionId) return;
    setClassEditBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("set-student-class", {
        body: {
          school_id: school.id,
          student_id: studentDbId,
          session_id: academicPeriods.selectedSessionId,
          new_class: newClass,
        },
      });
      const message = error || data?.error
        ? data?.error || (await readFunctionsError(error, "Something went wrong"))
        : null;
      if (message) {
        // The refusal when money has been paid is long on purpose — it explains
        // why, because "cannot change class" alone reads as a broken button.
        toast.error(message, { duration: 10000 });
        return;
      }
      if (data?.unchanged) {
        toast.info(data.message);
      } else {
        toast.success(`Class changed to ${newClass}. Fees for this session updated.`);
      }
      setClassEditFor(null);
      setSelectedStudent(null);
      loadData();
    } finally {
      setClassEditBusy(false);
    }
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSurname.trim() || !newFirstName.trim() || !newStudentClass) {
      toast.error("Surname, First Name, and Class are required");
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!newParentEmail.trim() || !emailRegex.test(newParentEmail.trim())) {
      toast.error("A valid Parent/Guardian email is required");
      return;
    }
    setAddingStudent(true);

    const fullName = [newSurname.trim(), newFirstName.trim(), newMiddleName.trim()].filter(Boolean).join(" ");
    const studentId = generateStudentCode(newSurname.trim(), newFirstName.trim(), newMiddleName.trim());
    // `pin` is hashed by the hash_student_pin DB trigger on write; `default_pin`
    // keeps the plaintext so the owner can read it back to hand over, and is
    // cleared the moment the student sets their own.
    const tempPassword = generateTempPassword();

    const { error } = await supabase.from("students").insert({
      school_id: school.id,
      student_id: studentId,
      name: fullName,
      class: newStudentClass,
      pin: tempPassword,
      default_pin: tempPassword,
      must_change_pin: true,
      parent_email: newParentEmail.trim().toLowerCase(),
      status: "active",
    } as any);

    if (error) {
      toast.error(error.message);
    } else {
      // Show the new student's login credentials at the TOP so they're clearly
      // visible on phones (the default toast sits bottom-right and is easy to
      // miss on mobile). It stays until dismissed and offers a one-tap Copy so
      // the owner can grab the ID + password to share.
      const credentialText = `EduLedgerNG student login\nStudent ID: ${studentId}\nTemporary password: ${tempPassword}\n\nThis password works once — you'll be asked to choose your own at first login.`;
      toast.success("Student added", {
        description: `Login ID: ${studentId}   ·   Temporary password: ${tempPassword}`,
        position: "top-center",
        duration: Infinity,
        closeButton: true,
        action: {
          label: "Copy",
          onClick: (e) => {
            // Keep the toast open after copying so the owner can still see it.
            e.preventDefault();
            navigator.clipboard?.writeText(credentialText);
            toast.success("Credentials copied", { position: "top-center", duration: 2000 });
          },
        },
      });
      // Jump the roster to the class just added to, so the new student is visible
      // immediately (otherwise a new Nursery/Primary school lands on an empty tab).
      setStudentsClassFilter(newStudentClass);
      setAddStudentOpen(false);
      setNewSurname(""); setNewFirstName(""); setNewMiddleName("");
      setNewStudentClass(""); setNewParentEmail("");
      loadData();
    }
    setAddingStudent(false);
  };

  // Students are never removed — only archived (reversible). Archiving hides
  // them from the active roster and stats but keeps all their records.
  const handleArchiveStudent = async (studentDbId: string, studentName: string) => {
    if (userRole !== "owner") {
      toast.error("Only owners can archive students");
      return;
    }
    if (!confirm(`Archive ${studentName}? They will be moved out of the active roster but their records are kept, and you can restore them anytime.`)) {
      return;
    }

    const { error } = await supabase.from("students").update({ status: "archived" }).eq("id", studentDbId);

    if (error) {
      toast.error("Failed to archive student");
    } else {
      toast.success(`${studentName} archived`);
      loadData();
    }
  };

  const handleRestoreStudent = async (studentDbId: string, studentName: string) => {
    if (userRole !== "owner") {
      toast.error("Only owners can restore students");
      return;
    }
    const { error } = await supabase.from("students").update({ status: "active" }).eq("id", studentDbId);
    if (error) {
      toast.error("Failed to restore student");
    } else {
      toast.success(`${studentName} restored to the active roster`);
      loadData();
    }
  };

  const handleResetPassword = async (studentDbId: string, studentName: string) => {
    // Only owners can reset student passwords
    if (userRole !== "owner") {
      toast.error("Only owners can reset student passwords");
      return;
    }
    const tempPassword = generateTempPassword();
    const { error } = await supabase.from("students").update({
      pin: tempPassword, default_pin: tempPassword, must_change_pin: true,
    }).eq("id", studentDbId);

    if (error) {
      toast.error("Failed to reset password");
      return;
    }

    // Any session this student had is now stale; verify_student_session keys off
    // the students row, and must_change_pin blocks data and checkout until the
    // new temporary password has been replaced.
    const credentialText = `EduLedgerNG student login\nStudent: ${studentName}\nTemporary password: ${tempPassword}`;
    toast.success(`Password reset for ${studentName}`, {
      description: `Temporary password: ${tempPassword}`,
      position: "top-center",
      duration: Infinity,
      closeButton: true,
      action: {
        label: "Copy",
        onClick: (e) => {
          e.preventDefault();
          navigator.clipboard?.writeText(credentialText);
          toast.success("Credentials copied", { position: "top-center", duration: 2000 });
        },
      },
    });
    loadData();
  };

  const toStudentNameParts = (fullName: string) => {
    const cleaned = fullName.trim().replace(/\s+/g, " ");
    const parts = cleaned.split(" ").filter(Boolean);
    return {
      surname: parts[0] || "STUDENT",
      firstName: parts[1] || "USER",
      middleName: parts.slice(2).join(" "),
      fullName: cleaned,
    };
  };

  const downloadStudentTemplate = () => {
    const csv = ["name,class", "Bello Aisha,Primary 3", "Okafor Chinedu,JSS1", "Adebayo Kemi,SSS2"].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "students-template.csv";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleBulkStudentUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !school?.id) return;
    setUploadingStudents(true);

    try {
      const extension = file.name.toLowerCase().split(".").pop();
      let normalizedRows: Record<string, string>[] = [];

      if (extension === "csv") {
        const text = await file.text();
        normalizedRows = parseCsvRows(text);
      } else if (extension === "xlsx" || extension === "xls") {
        const arrayBuffer = await file.arrayBuffer();
        const moduleName = "xlsx";
        const xlsxModule = await import(/* @vite-ignore */ moduleName);
        const workbook = xlsxModule.read(arrayBuffer, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) {
          toast.error("No worksheet found in the uploaded file");
          return;
        }

        const sheet = workbook.Sheets[firstSheetName];
        const rows = xlsxModule.utils.sheet_to_json(sheet, { defval: "" }) as Record<string, string | number>[];
        normalizedRows = rows.map((row) => {
          const mapped: Record<string, string> = {};
          Object.entries(row).forEach(([key, value]) => {
            mapped[normalizeHeader(key)] = String(value ?? "").trim();
          });
          return mapped;
        });
      } else {
        toast.error("Please upload a CSV, XLSX, or XLS file");
        return;
      }

      const inserts = normalizedRows
        .map((row) => {
          const rawName = row.name || row.fullname || row.studentname || row.student;
          const rawClass = row.class || row.studentclass || row.level;
          // Match case/space-insensitively and store the canonical class name,
          // so "primary 1", "Primary 1" and "PRIMARY 1" all resolve correctly.
          const normalizedClass = rawClass?.toUpperCase().trim();
          const className = NIGERIAN_CLASSES.find((c) => c.toUpperCase() === normalizedClass);
          if (!rawName || !className) return null;

          // Optional. The upload used to ignore parent email entirely, so a
          // school could not supply one in bulk even when it had them — every
          // uploaded roster landed with parent_email NULL. Accept the spellings
          // a school is likely to use; a row without one is still accepted and
          // falls back to the bouncing address at payment time.
          const rawEmail =
            row.parentemail || row.parent_email || row.guardianemail ||
            row.email || row.parentsemail || row.parentguardianemail;
          const parentEmail =
            typeof rawEmail === "string" && /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(rawEmail.trim())
              ? rawEmail.trim().toLowerCase()
              : null;

          const nameParts = toStudentNameParts(rawName);
          // A distinct temporary password per row — a shared one would put the
          // whole uploaded roster behind a single guess.
          const tempPassword = generateTempPassword();
          return {
            school_id: school.id,
            student_id: generateStudentCode(nameParts.surname, nameParts.firstName, nameParts.middleName),
            name: nameParts.fullName,
            class: className,
            pin: tempPassword,
            default_pin: tempPassword,
            must_change_pin: true,
            status: "active",
            parent_email: parentEmail,
          };
        })
        .filter(Boolean) as any[];

      if (inserts.length === 0) {
        toast.error(
          "No valid rows found. Use columns: name and class (JSS1-SSS3). " +
            "Parent email is optional."
        );
        return;
      }

      const { error } = await supabase.from("students").insert(inserts);
      if (error) {
        toast.error(error.message);
        return;
      }

      // Every uploaded student got their OWN random temporary password, so
      // unlike the old shared default there is nothing for the owner to guess.
      // Offer the credentials as a download — this is the only moment they are
      // all in one place, and the roster shows them individually afterwards.
      const csvEscape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
      const credentialsCsv = [
        "Student ID,Name,Class,Temporary Password",
        ...inserts.map((s) =>
          [s.student_id, s.name, s.class, s.default_pin].map(csvEscape).join(",")
        ),
      ].join("\n");

      toast.success(`${inserts.length} student(s) uploaded`, {
        description: "Download their login details — each student has a unique temporary password.",
        position: "top-center",
        duration: Infinity,
        closeButton: true,
        action: {
          label: "Download",
          onClick: (e) => {
            e.preventDefault();
            const blob = new Blob([credentialsCsv], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${school.slug || "school"}-student-logins.csv`;
            a.click();
            URL.revokeObjectURL(url);
          },
        },
      });
      loadData();
    } catch (error: any) {
      if (String(error?.message || "").includes("Failed to resolve module specifier")) {
        toast.error("Excel upload dependency is missing. Use CSV for now, or install 'xlsx'.");
      } else {
        toast.error("Upload failed. Please check the file format and try again.");
      }
    } finally {
      setUploadingStudents(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleAddFee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feeClass) { toast.error("Please select a class"); return; }
    if (!feeSessionId || !feeTermId) { toast.error("Please select a session and term"); return; }

    // Published fees are locked for the session — only new/pending entries can be saved
    const validFees = feeEntries.filter((f) => !f.locked && f.name.trim() && Number(f.amount) > 0);
    if (validFees.length === 0) {
      toast.error("Nothing to save — published fees are locked, add an amount to an unlocked fee");
      return;
    }

    setAddingFee(true);

    try {
      // Re-check statuses server-side right before writing: a fee published
      // while this dialog was open must never reach the upsert (the DB trigger
      // would abort the whole batch).
      const { data: currentRows } = await supabase
        .from("class_fees")
        .select("name, status")
        .eq("school_id", school.id)
        .eq("class_target", feeClass)
        .eq("session_id", feeSessionId)
        .eq("term_id", feeTermId);
      const publishedNames = new Set(
        (currentRows || []).filter((r) => r.status === "published").map((r) => r.name)
      );
      const writableFees = validFees.filter((f) => !publishedNames.has(f.name.trim()));
      if (writableFees.length === 0) {
        toast.error("These fees were published in the meantime and are now locked.");
        setAddFeeOpen(false);
        loadData();
        return;
      }

      const upserts = writableFees.map((f) => ({
        school_id: school.id,
        class_target: feeClass,
        name: f.name.trim(),
        amount: Number(f.amount),
        session_id: feeSessionId,
        term_id: feeTermId,
        status: "pending",
        created_by: userId,
      }));

      const { error } = await supabase.from("class_fees").upsert(upserts, {
        onConflict: "school_id,class_target,name,session_id,term_id",
      });

      if (error) {
        toast.error(error.message);
      } else {
        const skipped = validFees.length - writableFees.length;
        toast.success(
          (userRole === "owner"
            ? `${writableFees.length} fee(s) submitted — approve them in the Fees tab to publish to students.`
            : `${writableFees.length} fee(s) submitted for owner approval.`) +
            (skipped > 0 ? ` ${skipped} already-published fee(s) were skipped.` : "")
        );
        setAddFeeOpen(false);
        setFeeClass("");
        setFeeEntries(DEFAULT_FEE_TEMPLATES.map((name) => ({ name, amount: "" })));
        setHasExistingFees(false);
        loadData();
      }
    } catch (error) {
      console.error("Error upserting fees:", error);
      toast.error("An error occurred while saving fees");
    } finally {
      setAddingFee(false);
    }
  };

  // Owner approves (publishes) or rejects (deletes) a pending fee
  const handleApproveFee = async (feeId: string, classTarget: string) => {
    // Warn if this fee applies to no current students — it will publish fine,
    // but won't appear in anyone's balance until a student joins that class.
    const applies = countStudentsInClass(classTarget);
    if (applies === 0) {
      const where = classTarget === "ALL" ? "any class" : classTarget;
      if (!confirm(`No students are currently in ${where}. You can still publish this fee — it will apply automatically once a student is added there. Publish now?`)) {
        return;
      }
    }
    setApprovingFeeId(feeId);
    const { error } = await supabase
      .from("class_fees")
      .update({ status: "published", approved_by: userId, approved_at: new Date().toISOString() })
      .eq("id", feeId);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Fee published! Students can now see and pay it. It is locked for this session.");
      loadData();
    }
    setApprovingFeeId(null);
  };

  const handleRejectFee = async (feeId: string, feeName: string) => {
    if (!confirm(`Reject and remove the pending fee "${feeName}"?`)) return;
    setApprovingFeeId(feeId);
    const { error } = await supabase.from("class_fees").delete().eq("id", feeId);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Pending fee removed");
      loadData();
    }
    setApprovingFeeId(null);
  };

  // Load current staff whenever an owner opens the dialog
  useEffect(() => {
    if (addBursarOpen && userRole === "owner" && school?.id) {
      loadStaff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addBursarOpen, userRole, school?.id]);

  const resetBursarForm = () => {
    setBursarEmail("");
    setBursarFullName("");
    setBursarPassword("");
    setBursarConfirmPassword("");
    setShowPassword(false);
    setCreatedCredentials(null);
  };

  const generateBursarPassword = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let pw = "";
    const rand = new Uint32Array(10);
    crypto.getRandomValues(rand);
    for (const r of rand) pw += chars[r % chars.length];
    setBursarPassword(pw);
    setBursarConfirmPassword(pw);
    setShowPassword(true);
  };

  const handleAddBursar = async (e: React.FormEvent) => {
    e.preventDefault();

    const cleanEmail = bursarEmail.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!cleanEmail || !emailRegex.test(cleanEmail)) {
      toast.error("Please enter a valid email address");
      return;
    }
    if (bursarPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (bursarPassword !== bursarConfirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    setAddingBursar(true);

    try {
      const { data, error } = await supabase.functions.invoke("add-bursar", {
        body: {
          email: cleanEmail,
          schoolId: school.id,
          role: "bursar",
          password: bursarPassword,
          fullName: bursarFullName.trim() || undefined,
        },
      });

      if (error || data?.error) {
        toast.error(data?.error || (await readFunctionsError(error, "Failed to add bursar")));
        return;
      }

      // Show the credentials so the owner can share them with the bursar
      setCreatedCredentials({ email: cleanEmail, password: bursarPassword });
      toast.success("Bursar account created and added to this school!");
      loadData();
      loadStaff();
    } catch (err) {
      console.error("Error adding bursar:", err);
      toast.error("An unexpected error occurred");
    } finally {
      setAddingBursar(false);
    }
  };

  // Logout handler
  const handleLogout = async () => {
    try {
      localStorage.clear();
      await supabase.auth.signOut();
      navigate(`/school/${slug}`, { replace: true });
    } catch (error) {
      console.error("Logout runtime error encountered:", error);
      window.location.href = `/school/${slug}`;
    }
  };

  const handleViewStudent = async (student: StudentRow) => {
    setSelectedStudent(student);
    setLoadingFees(true);

    const applicableFees = getChargedFees(student.id);
    const feeBreakdown = applicableFees.map((cf) => {
      const paid = getPaidForFee(student.id, { id: cf.id, name: cf.name }, Number(cf.amount));
      const status = paid >= Number(cf.amount) ? "Cleared" : paid > 0 ? "Partial" : "Unpaid";
      const termObj = academicPeriods.terms.find((t) => t.id === cf.term_id);
      const sessionObj = academicPeriods.sessions.find((s) => s.id === cf.session_id);
      return {
        id: cf.id, name: cf.name, amount: cf.amount, paid, status,
        termName: termObj?.name || "", sessionName: sessionObj?.name || "",
      };
    });

    setStudentFees(feeBreakdown);
    setLoadingFees(false);
  };

  const portalUrl = `${window.location.origin}/school/${slug}`;
  const copyPortalLink = () => { navigator.clipboard.writeText(portalUrl); toast.success("Portal link copied!"); };

  // Export reports function
  // The debtors list: who owes what, across every term. Exported rather than
  // only shown, because chasing fees happens off the dashboard — on a phone, in
  // a staff meeting, or attached to a message home.
  const exportReport = () => {
    const debtors = activeStudents
      .map((s) => ({ s, owing: owingAllPeriods.get(s.id) || 0 }))
      .filter((r) => r.owing > 0)
      .sort((a, b) => b.owing - a.owing);

    if (debtors.length === 0) {
      toast.success("Nobody is owing. Nothing to export.");
      return;
    }

    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [
      "Student ID,Name,Class,Parent Email,Total Owing (NGN)",
      ...debtors.map((r) =>
        [r.s.student_id, r.s.name, r.s.class, r.s.parent_email || "", r.owing]
          .map(esc)
          .join(",")
      ),
      "",
      esc(`Total owed to ${school?.name || "this school"}`) + ",,,," +
        esc(debtors.reduce((a, r) => a + r.owing, 0)),
    ].join("\n");

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${school?.slug || "school"}-owing-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${debtors.length} student(s) owing. Downloaded.`);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Stats based on filtered period (term-specific)
  const totalStudents = academicPeriods.isFutureSession ? 0 : studentsWithTotals.length;
  const totalCollected = settledPaymentsByPeriod.reduce((s, p) => s + Number(p.amount), 0);
  const totalFees = studentsWithTotals.reduce((s, st) => s + st.totalFees, 0);
  const outstanding = totalFees - studentsWithTotals.reduce((s, st) => s + st.totalPaid, 0);

  // Future sessions are blank everywhere, including the student roster.
  // The archived toggle swaps the active roster for the archived one.
  const rosterBase = showArchived
    ? archivedStudents.map((s) => ({ ...s, totalFees: 0, totalPaid: 0 }))
    : studentsWithTotals;
  const filteredStudents = academicPeriods.isFutureSession
    ? []
    : rosterBase.filter((s) => {
        const matchClass = s.class === studentsClassFilter;
        const matchSearch = !search ||
          (s.name || "").toLowerCase().includes(search.toLowerCase()) ||
          (s.student_id || "").toLowerCase().includes(search.toLowerCase());
        return matchClass && matchSearch;
      });

  const filteredPayments = filteredPaymentsByPeriod.filter((p) => {
    const studentData = p.students as any;
    const matchClass = paymentsClassFilter === "ALL" || studentData?.class === paymentsClassFilter;
    // reference can be null on legacy rows — guard before .toLowerCase(), or a
    // single non-empty search keystroke crashes the whole dashboard render.
    const matchSearch = !search ||
      (studentData?.name || "").toLowerCase().includes(search.toLowerCase()) ||
      (p.reference || "").toLowerCase().includes(search.toLowerCase());
    return matchClass && matchSearch;
  });

  const formatDateTime = (dateStr: string | null) => {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "—";
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    const time = d.toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit", hour12: true });
    if (isToday) return `Today ${time}`;
    if (isYesterday) return `Yesterday ${time}`;
    return d.toLocaleDateString("en-NG", { day: "numeric", month: "short" }) + ` ${time}`;
  };

  // Fee dialog term options
  const feeTermOptions = academicPeriods.terms.filter((t) => t.session_id === feeSessionId);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center justify-between gap-2 h-16 px-4">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <img src="/logo.jpeg" alt="" className="w-8 h-8 rounded-lg object-contain shrink-0" />
            <span className="font-bold text-base sm:text-lg truncate">{school?.name}</span>
            <Badge variant="outline" className="hidden sm:inline-flex text-xs capitalize shrink-0">
              {userRole || "Admin"}
            </Badge>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <NotificationBell schoolId={school?.id} />
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0"
              onClick={() => navigate("/main-dashboard")}
              title="Dashboard"
            >
              <Home className="w-4 h-4" />
            </Button>
            {userRole === "owner" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={() => navigate(`/school/${slug}/settings`)}
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => navigate("/change-password")} title="Change password">
              <KeyRound className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={handleLogout} title="Log out">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Portal Link */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <LinkIcon className="w-5 h-5 text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-muted-foreground">Your School Portal Link</p>
                  <p className="text-sm text-primary font-mono break-all">{portalUrl}</p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={copyPortalLink} className="gap-2 shrink-0">
                <Copy className="w-4 h-4" /> Copy Link
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Session & Term Filter */}
        <div className="flex flex-col sm:flex-row items-end gap-3">
          <div className="flex-1 w-full">
            <AcademicPeriodSelector
              sessions={academicPeriods.sessionOptions}
              termsForSelectedSession={academicPeriods.termsForSelectedSession}
              selectedSessionId={academicPeriods.selectedSessionId}
              selectedTermId={academicPeriods.selectedTermId}
              onSessionChange={academicPeriods.setSelectedSessionId}
              onTermChange={academicPeriods.setSelectedTermId}
            />
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center"><Users className="w-5 h-5 text-primary" /></div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Students</p>
                  <p className="text-2xl font-bold">{totalStudents}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center"><TrendingUp className="w-5 h-5 text-primary" /></div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Collected</p>
                  <p className="text-2xl font-bold">{formatNaira(totalCollected)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center"><Wallet className="w-5 h-5 text-destructive" /></div>
                <div>
                  {/* Plain words, and the ALL-PERIODS figure underneath. The
                      top number is this term only, which is what the period
                      selector implies; the debt a school actually chases spans
                      terms and was previously visible nowhere. */}
                  {/* Only claim "this term" when a term is actually selected.
                      With none chosen the figure already spans every term, and
                      mislabelling it is the exact confusion this stage exists
                      to remove. */}
                  <p className="text-sm text-muted-foreground">
                    {academicPeriods.selectedTermId ? "Owing this term" : "Total owing"}
                  </p>
                  <p className="text-2xl font-bold">{formatNaira(outstanding)}</p>
                  {owingGrandTotal > outstanding && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatNaira(owingGrandTotal)} owed in total by {debtorCount} student
                      {debtorCount === 1 ? "" : "s"}, across all terms
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters & Actions */}
        <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search students or references..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={handleBulkStudentUpload}
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="gap-2"
            disabled={uploadingStudents || academicPeriods.isFutureSession}
          >
            <Upload className="w-4 h-4" /> {uploadingStudents ? "Uploading..." : "Upload CSV/Excel"}
          </Button>
          <Button variant="outline" onClick={downloadStudentTemplate} className="gap-2">
            <Download className="w-4 h-4" /> Download Template
          </Button>
          {/* Owner-only: rollover changes every student's class at once. */}
          {userRole === "owner" && (
            <Button
              variant="outline"
              onClick={() => { setPromotePreview(null); setPromoteOpen(true); }}
              className="gap-2"
              disabled={academicPeriods.isFutureSession}
              title={academicPeriods.isFutureSession
                ? "Switch to a real session first"
                : "Move every student up a class at the end of the year"}
            >
              <ChevronsUp className="w-4 h-4" /> Move Up a Class
            </Button>
          )}
          <Button
            onClick={() => setAddStudentOpen(true)}
            className="gap-2"
            disabled={academicPeriods.isFutureSession}
            title={academicPeriods.isFutureSession ? "Upcoming sessions cannot be edited yet" : undefined}
          >
            <UserPlus className="w-4 h-4" /> Add Student
          </Button>
          
          {/* Export Report - available to both owners and bursars */}
          <Button variant="outline" onClick={exportReport} className="gap-2">
            <FileSpreadsheet className="w-4 h-4" /> Who Owes (CSV)
          </Button>

          {/* Owner-only actions */}
          {userRole === "owner" && (
            <Button variant="outline" onClick={() => setAddBursarOpen(true)} className="gap-2">
              <UserCog className="w-4 h-4" /> Add Bursar
            </Button>
          )}
          {/* Fees can be proposed by owners and bursars; future sessions are locked */}
          <Button
            variant="outline"
            onClick={() => setAddFeeOpen(true)}
            className="gap-2"
            disabled={academicPeriods.isFutureSession}
            title={academicPeriods.isFutureSession ? "Upcoming sessions cannot be edited yet" : undefined}
          >
            <Plus className="w-4 h-4" /> Add Fee
          </Button>
        </div>

        <Tabs defaultValue="students">
          <TabsList>
            <TabsTrigger value="students">Students</TabsTrigger>
            <TabsTrigger value="fees" className="gap-1.5">
              Fees
              {pendingFeesCount > 0 && (
                <Badge variant="destructive" className="h-4 min-w-4 px-1 text-[10px]">{pendingFeesCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
          </TabsList>

          <TabsContent value="students">
            {selectedStudent ? (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <Button variant="ghost" size="icon" onClick={() => setSelectedStudent(null)}>
                      <ChevronLeft className="w-5 h-5" />
                    </Button>
                    <div className="min-w-0">
                      <CardTitle className="text-lg">{selectedStudent.name}</CardTitle>
                      <p className="text-sm text-muted-foreground">{selectedStudent.student_id} · {selectedStudent.class}</p>
                      {selectedStudent.parent_email && (
                        <p className="text-xs text-muted-foreground mt-0.5">Parent: {selectedStudent.parent_email}</p>
                      )}
                      {/* Correcting a class was impossible before the enrolment
                          table existed. It changes the enrolment for the session
                          on screen, so earlier years keep the class they had. */}
                      {userRole === "owner" && !academicPeriods.isFutureSession && (
                        <div className="mt-2">
                          {classEditFor === selectedStudent.id ? (
                            <div className="flex items-center gap-2">
                              <Select
                                disabled={classEditBusy}
                                onValueChange={(v) => handleChangeClass(selectedStudent.id, v)}
                              >
                                <SelectTrigger className="h-8 w-40 text-xs">
                                  <SelectValue placeholder="Move to class..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {NIGERIAN_CLASSES.filter((c) => c !== selectedStudent.class).map((c) => (
                                    <SelectItem key={c} value={c}>{c}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button variant="ghost" size="sm" className="h-8 text-xs"
                                      disabled={classEditBusy}
                                      onClick={() => setClassEditFor(null)}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <Button variant="outline" size="sm" className="h-7 text-xs"
                                    onClick={() => setClassEditFor(selectedStudent.id)}>
                              Change class
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {loadingFees ? (
                    <div className="flex justify-center py-8">
                      <div className="w-6 h-6 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : studentFees.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">No fees set for this period yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {studentFees.map((fee: any) => {
                        const progressPercent = fee.amount > 0 ? (fee.paid / fee.amount) * 100 : 0;
                        return (
                          <div key={fee.id} className="flex items-center justify-between p-3 rounded-lg border">
                            <div>
                              <p className="font-medium">{fee.name}</p>
                              <p className="text-sm text-muted-foreground">
                                {formatNaira(Number(fee.amount))}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b">
                    <div className="flex flex-wrap gap-1">
                      {NIGERIAN_CLASSES.map((c) => (
                        <Button
                          key={c}
                          variant={studentsClassFilter === c ? "default" : "ghost"}
                          size="sm"
                          onClick={() => setStudentsClassFilter(c)}
                        >
                          {c}
                        </Button>
                      ))}
                    </div>
                    {userRole === "owner" && (
                      <Button
                        variant={showArchived ? "default" : "outline"}
                        size="sm"
                        className="gap-1.5 shrink-0"
                        onClick={() => setShowArchived((v) => !v)}
                      >
                        <Archive className="w-3.5 h-3.5" />
                        {showArchived ? `Viewing Archived (${archivedStudents.length})` : `Archived (${archivedStudents.length})`}
                      </Button>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Student ID</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead>Class</TableHead>
                          <TableHead>Fees Status</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredStudents.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                              {academicPeriods.isFutureSession
                                ? "This session hasn't started yet."
                                : showArchived
                                  ? "No archived students in this class."
                                  : "No students found."}
                            </TableCell>
                          </TableRow>
                        ) : (
                          filteredStudents.map((student) => {
                            const isCleared = student.totalFees > 0 && student.totalPaid >= student.totalFees;
                            const isPartial = student.totalPaid > 0 && student.totalPaid < student.totalFees;
                            const hasNoFees = student.totalFees === 0;

                            return (
                              <TableRow key={student.id}>
                                <TableCell className="font-mono text-sm">{student.student_id}</TableCell>
                                <TableCell className="font-medium">
                                  {student.name}
                                  {/* Each student now gets their own random temporary password, so
                                      after a CSV upload the owner has no other way to learn them.
                                      Shown only until the student sets their own — the DB clears
                                      default_pin at that point (20260803130000). */}
                                  {student.must_change_pin && student.default_pin && (
                                    <span className="block text-xs font-normal text-muted-foreground mt-0.5">
                                      Temp password: <span className="font-mono select-all">{student.default_pin}</span>
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>{student.class}</TableCell>
                                <TableCell>
                                  {hasNoFees ? (
                                    <Badge variant="secondary">No Fees Set</Badge>
                                  ) : isCleared ? (
                                    <Badge className="bg-green-600 hover:bg-green-600 text-white">Cleared</Badge>
                                  ) : isPartial ? (
                                    <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                                      Partial ({Math.round((student.totalPaid / student.totalFees) * 100)}%)
                                    </Badge>
                                  ) : (
                                    <Badge variant="destructive">Unpaid</Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    {showArchived ? (
                                      userRole === "owner" && (
                                        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => handleRestoreStudent(student.id, student.name)}>
                                          <ArchiveRestore className="w-3.5 h-3.5" /> Restore
                                        </Button>
                                      )
                                    ) : (
                                      <>
                                        <Button variant="ghost" size="sm" onClick={() => handleViewStudent(student)}>
                                          View Fees
                                        </Button>
                                        {/* Owners can reset password and archive (students are never hard-deleted) */}
                                        {userRole === "owner" && (
                                          <>
                                            <Button variant="ghost" size="icon" onClick={() => handleResetPassword(student.id, student.name)} title="Reset Password">
                                              <KeyRound className="w-4 h-4 text-muted-foreground" />
                                            </Button>
                                            <Button variant="ghost" size="icon" onClick={() => handleArchiveStudent(student.id, student.name)} title="Archive Student">
                                              <Archive className="w-4 h-4 text-muted-foreground" />
                                            </Button>
                                          </>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="fees">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Fees for {academicPeriods.selectedSession?.name || "selected period"} (all terms)</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Pending fees are only visible to staff. Once an owner approves a fee it is
                  published to students and locked for the entire session.
                </p>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Class</TableHead>
                        <TableHead>Fee Name</TableHead>
                        <TableHead>Term</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-center">Applies to</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sessionClassFees.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                            {academicPeriods.isFutureSession
                              ? "This session hasn't started yet."
                              : "No fees created for this session yet. Use “Add Fee” to create some."}
                          </TableCell>
                        </TableRow>
                      ) : (
                        [...sessionClassFees]
                          .sort((a, b) => a.class_target.localeCompare(b.class_target) || a.name.localeCompare(b.name))
                          .map((fee) => (
                            <TableRow key={fee.id}>
                              <TableCell className="font-medium">
                                {fee.class_target === "ALL" ? "All Classes" : fee.class_target}
                              </TableCell>
                              <TableCell>{fee.name}</TableCell>
                              <TableCell className="text-muted-foreground">
                                {academicPeriods.terms.find((t) => t.id === fee.term_id)?.name || "—"}
                              </TableCell>
                              <TableCell className="text-right">{formatNaira(Number(fee.amount))}</TableCell>
                              <TableCell className="text-center">
                                {(() => {
                                  const n = countStudentsInClass(fee.class_target);
                                  return n === 0 ? (
                                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-900/20 dark:text-amber-400 text-xs" title="No students in this class yet — this fee affects no balance until one is added">
                                      0 students
                                    </Badge>
                                  ) : (
                                    <span className="text-sm">{n} student{n === 1 ? "" : "s"}</span>
                                  );
                                })()}
                              </TableCell>
                              <TableCell>
                                {fee.status === "published" ? (
                                  <Badge className="bg-green-600 hover:bg-green-600 text-white gap-1">
                                    Published
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                                    Pending Approval
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                {fee.status === "pending" && userRole === "owner" ? (
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      size="sm"
                                      onClick={() => handleApproveFee(fee.id, fee.class_target)}
                                      disabled={approvingFeeId === fee.id}
                                      className="gap-1"
                                    >
                                      {approvingFeeId === fee.id ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      ) : null}
                                      Approve & Publish
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => handleRejectFee(fee.id, fee.name)}
                                      disabled={approvingFeeId === fee.id}
                                      title="Reject and remove"
                                    >
                                      <Trash2 className="w-4 h-4 text-destructive" />
                                    </Button>
                                  </div>
                                ) : fee.status === "pending" ? (
                                  <span className="text-xs text-muted-foreground">Awaiting owner</span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Locked for session</span>
                                )}
                              </TableCell>
                            </TableRow>
                          ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="payments">
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b">
                  <div className="flex flex-wrap gap-1">
                    <Button variant={paymentsClassFilter === "ALL" ? "default" : "ghost"} size="sm" onClick={() => setPaymentsClassFilter("ALL")}>
                      All Classes
                    </Button>
                    {NIGERIAN_CLASSES.map((c) => (
                      <Button key={c} variant={paymentsClassFilter === c ? "default" : "ghost"} size="sm" onClick={() => setPaymentsClassFilter(c)}>
                        {c}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Reference</TableHead>
                        <TableHead>Student</TableHead>
                        <TableHead>Class</TableHead>
                        <TableHead>Fees Paid</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Receipt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPayments.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                            No payments recorded.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredPayments.map((payment) => {
                          const studentData = payment.students as any;
                          const paidItems = parsePaymentItems(payment.items || []);
                          const payStatus = (payment.status as string) || "success";
                          const isSettled = payStatus !== "pending" && payStatus !== "failed";
                          return (
                            <TableRow key={payment.id} className={isSettled ? "" : "opacity-70"}>
                              <TableCell className="font-mono text-xs">{payment.reference}</TableCell>
                              <TableCell className="font-medium">{studentData?.name || "Unknown Student"}</TableCell>
                              <TableCell>{studentData?.class || "N/A"}</TableCell>
                              <TableCell className="text-xs max-w-[220px]">
                                {paidItems.length > 0
                                  ? paidItems.map((i) => i.name).join(", ")
                                  : "—"}
                              </TableCell>
                              <TableCell className={`font-semibold ${isSettled ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
                                {formatNaira(Number(payment.amount))}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={
                                    payStatus === "failed"
                                      ? "bg-destructive/10 text-destructive border-destructive/30"
                                      : payStatus === "pending"
                                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                                      : "bg-primary/15 text-primary border-primary/30"
                                  }
                                >
                                  {payStatus === "failed" ? "Failed" : payStatus === "pending" ? "Pending" : "Success"}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-muted-foreground text-sm">{formatDateTime(payment.date)}</TableCell>
                              <TableCell className="text-right">
                                {!isSettled ? (
                                  <span className="text-muted-foreground text-xs">—</span>
                                ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    generateReceiptPdf({
                                      schoolName: school?.name || "School",
                                      studentName: studentData?.name || "Unknown Student",
                                      studentId: studentData?.student_id || "",
                                      studentClass: studentData?.class || "",
                                      term: academicPeriods.terms.find((t) => t.id === payment.term_id)?.name || "",
                                      session: academicPeriods.sessions.find((s) => s.id === payment.session_id)?.name || "",
                                      reference: payment.reference || "",
                                      date: payment.date,
                                      method: payment.method || "",
                                      totalPaid: Number(payment.amount || 0),
                                      items: parsePaymentItems(payment.items || []),
                                    })
                                  }
                                  className="gap-1.5"
                                >
                                  <Download className="w-3.5 h-3.5" /> PDF
                                </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Add Student Dialog */}
      {/* Year-end rollover. Preview first, always: a school with 400 students
          cannot check a roster by eye, so the exceptions are what matters. */}
      <Dialog
        open={promoteOpen}
        onOpenChange={(o) => { setPromoteOpen(o); if (!o) setPromotePreview(null); }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Move students up a class</DialogTitle>
            <DialogDescription>
              Everyone in {academicPeriods.selectedSession?.name || "this session"} moves up one
              class. Students in your highest class finish and are marked as leavers. Nothing
              changes until you confirm.
            </DialogDescription>
          </DialogHeader>

          {!promotePreview ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Move them into</Label>
                <Select value={promoteTarget} onValueChange={setPromoteTarget}>
                  <SelectTrigger><SelectValue placeholder="Choose the new session" /></SelectTrigger>
                  <SelectContent>
                    {academicPeriods.sessionOptions
                      .filter((o) => o.id !== academicPeriods.selectedSessionId)
                      // Later sessions only. Promoting into a past session is
                      // never intended, and its preview is an empty no-op that
                      // reads as the feature being broken.
                      .filter((o) => {
                        const year = (n?: string) => Number((n || "").slice(0, 4));
                        const here = year(academicPeriods.selectedSession?.name);
                        const there = year(o.name);
                        return !Number.isFinite(here) || !Number.isFinite(there) || there > here;
                      })
                      .map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.name}{o.isFuture ? " (will be created)" : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <Button className="w-full" disabled={promoteBusy || !promoteTarget}
                      onClick={() => runPromotion("preview")}>
                {promoteBusy ? "Checking..." : "Show me what will happen"}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="p-3 rounded-lg border">
                  <p className="text-2xl font-bold">{promotePreview.summary.promoting}</p>
                  <p className="text-xs text-muted-foreground">moving up</p>
                </div>
                <div className="p-3 rounded-lg border">
                  <p className="text-2xl font-bold">{promotePreview.summary.graduating}</p>
                  <p className="text-xs text-muted-foreground">finishing school</p>
                </div>
                <div className="p-3 rounded-lg border">
                  <p className="text-2xl font-bold">{promotePreview.summary.total}</p>
                  <p className="text-xs text-muted-foreground">students in total</p>
                </div>
              </div>

              {/* The exceptions. These are the reason preview exists. */}
              {promotePreview.summary.unknown_class > 0 && (
                <div className="p-3 rounded-lg border border-destructive/40 bg-destructive/5 text-sm">
                  <p className="font-medium">
                    {promotePreview.summary.unknown_class} student(s) are in a class we do not
                    recognise
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    They will be left exactly as they are. Fix their class first if they should
                    move up.
                  </p>
                </div>
              )}
              {promotePreview.summary.owing > 0 && (
                <div className="p-3 rounded-lg border text-sm">
                  <p className="font-medium">
                    {promotePreview.summary.owing} student(s) still owe{" "}
                    {formatNaira(promotePreview.summary.owing_total)}
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    They still move up, and what they owe stays on their record.
                  </p>
                </div>
              )}
              {promotePreview.summary.already_done > 0 && (
                <div className="p-3 rounded-lg border text-sm">
                  <p className="font-medium">
                    {promotePreview.summary.already_done} already enrolled in{" "}
                    {promotePreview.summary.to_session}
                  </p>
                  <p className="text-muted-foreground mt-0.5">They will be skipped.</p>
                </div>
              )}

              <div className="border rounded-lg divide-y max-h-64 overflow-y-auto">
                {promotePreview.plans.map((p) => (
                  <div key={p.student_id} className="flex items-center justify-between p-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.student_code}</p>
                    </div>
                    <div className="text-right shrink-0 pl-3">
                      <p className={p.action === "unknown" ? "text-destructive" : ""}>
                        {p.action === "promote" ? `${p.from_class} → ${p.to_class}`
                          : p.action === "graduate" ? `${p.from_class} → finishing`
                          : `${p.from_class} → not recognised`}
                      </p>
                      {p.outstanding > 0 && (
                        <p className="text-xs text-muted-foreground">
                          owes {formatNaira(p.outstanding)}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" disabled={promoteBusy}
                        onClick={() => setPromotePreview(null)}>
                  Back
                </Button>
                <Button className="flex-1" disabled={promoteBusy}
                        onClick={() => runPromotion("commit")}>
                  {promoteBusy
                    ? "Working..."
                    : `Move ${promotePreview.summary.promoting} student(s) up`}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={addStudentOpen} onOpenChange={setAddStudentOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <form onSubmit={handleAddStudent}>
            <DialogHeader>
              <DialogTitle>Add New Student</DialogTitle>
              <DialogDescription>Create an account profile for a new student here.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1 col-span-1">
                  <Label htmlFor="surname">Surname</Label>
                  <Input id="surname" placeholder="e.g. Okafor" value={newSurname} onChange={(e) => setNewSurname(e.target.value)} required />
                </div>
                <div className="space-y-1 col-span-1">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input id="firstName" placeholder="e.g. Chinedu" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} required />
                </div>
                <div className="space-y-1 col-span-1">
                  <Label htmlFor="middleName">Middle Name</Label>
                  <Input id="middleName" placeholder="Optional" value={newMiddleName} onChange={(e) => setNewMiddleName(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="studentClass">Class Assigned</Label>
                <Select value={newStudentClass} onValueChange={setNewStudentClass} required>
                  <SelectTrigger id="studentClass">
                    <SelectValue placeholder="Select Class Level" />
                  </SelectTrigger>
                  <SelectContent>
                    {NIGERIAN_CLASSES.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="parentEmail">Parent/Guardian Email</Label>
                <Input id="parentEmail" type="email" placeholder="parent@example.com" value={newParentEmail} onChange={(e) => setNewParentEmail(e.target.value)} required />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddStudentOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addingStudent}>{addingStudent ? "Saving..." : "Save Student"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Bursar Dialog - Owners Only */}
      <Dialog open={addBursarOpen} onOpenChange={setAddBursarOpen}>
        <DialogContent className="sm:max-w-[450px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Bursar</DialogTitle>
            {createdCredentials && (
              <DialogDescription>
                Account created — share these login details with your bursar.
              </DialogDescription>
            )}
          </DialogHeader>
          {createdCredentials ? (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Login page</span>
                  <span className="font-mono">{`${window.location.origin}/login`}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Email</span>
                  <span className="font-mono">{createdCredentials.email}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Password</span>
                  <span className="font-mono">{createdCredentials.password}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Send these to your bursar privately and ask them to change the password after
                first login. This is the only time the password is shown.
              </p>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `EduLedgerNG bursar login\nURL: ${window.location.origin}/login\nEmail: ${createdCredentials.email}\nPassword: ${createdCredentials.password}`
                    );
                    toast.success("Login details copied");
                  }}
                  className="gap-2"
                >
                  <Copy className="w-4 h-4" /> Copy Details
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setAddBursarOpen(false);
                    resetBursarForm();
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
          <>
            {/* Current staff */}
            {(staffMembers.length > 0 || loadingStaff) && (
              <div className="space-y-2 border-b pb-4 mb-2">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Current Staff
                </Label>
                {loadingStaff ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {staffMembers.map((m) => (
                      <div key={m.user_id} className="flex items-center justify-between gap-2 text-sm rounded-md border px-3 py-2">
                        <div className="min-w-0">
                          <span className="truncate block">{m.email}</span>
                          <span className="text-xs text-muted-foreground capitalize">{m.role}</span>
                        </div>
                        {m.role === "owner" ? (
                          <Badge variant="outline" className="text-xs shrink-0">Owner</Badge>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive shrink-0 h-7"
                            disabled={staffActionId === m.user_id}
                            onClick={() => handleRemoveBursar(m.user_id, m.email)}
                          >
                            {staffActionId === m.user_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Remove"}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          <form onSubmit={handleAddBursar}>
            <div className="grid gap-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="bursarEmail">Bursar's Email *</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="bursarEmail"
                    type="email"
                    placeholder="bursar@school.com"
                    className="pl-9"
                    value={bursarEmail}
                    onChange={(e) => setBursarEmail(e.target.value)}
                    required
                    disabled={addingBursar}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Share these details with the bursar — they'll set their own password on first login.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bursarFullName">Bursar's Full Name</Label>
                <Input
                  id="bursarFullName"
                  placeholder="e.g. Ngozi Okeke"
                  value={bursarFullName}
                  onChange={(e) => setBursarFullName(e.target.value)}
                  disabled={addingBursar}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="bursarPassword">Temporary Password *</Label>
                  <Button type="button" variant="link" className="p-0 h-auto text-xs" onClick={generateBursarPassword}>
                    Generate
                  </Button>
                </div>
                <div className="relative">
                  <Input
                    id="bursarPassword"
                    type={showPassword ? "text" : "password"}
                    placeholder="Min. 6 characters"
                    value={bursarPassword}
                    onChange={(e) => setBursarPassword(e.target.value)}
                    minLength={6}
                    disabled={addingBursar}
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <Eye className="w-4 h-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bursarConfirmPassword">Confirm Password *</Label>
                <Input
                  id="bursarConfirmPassword"
                  type={showPassword ? "text" : "password"}
                  placeholder="Repeat the password"
                  value={bursarConfirmPassword}
                  onChange={(e) => setBursarConfirmPassword(e.target.value)}
                  minLength={6}
                  disabled={addingBursar}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAddBursarOpen(false);
                  resetBursarForm();
                }}
                disabled={addingBursar}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  addingBursar ||
                  bursarPassword.length < 6 ||
                  bursarPassword !== bursarConfirmPassword
                }
              >
                {addingBursar ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Bursar Account"
                )}
              </Button>
            </DialogFooter>
          </form>
          </>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Fee Dialog - Owners Only */}
      <Dialog open={addFeeOpen} onOpenChange={setAddFeeOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[85vh] flex flex-col p-0">
          <form onSubmit={handleAddFee} className="flex flex-col h-full overflow-hidden">
            <DialogHeader className="p-6 pb-2 shrink-0">
              <DialogTitle>{hasExistingFees ? "Update Class Term Fees" : "Configure Class Term Fees"}</DialogTitle>
              <DialogDescription>
                New fees are saved as <span className="font-medium">pending</span> and must be
                approved by an owner before students can see them. Once published, a fee is
                locked for the entire session.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 p-6 py-2 overflow-y-auto flex-1">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="feeSession">Academic Session</Label>
                  <Select value={feeSessionId} onValueChange={setFeeSessionId} required>
                    <SelectTrigger id="feeSession">
                      <SelectValue placeholder="Choose Session" />
                    </SelectTrigger>
                    <SelectContent>
                      {academicPeriods.sessions.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="feeTerm">Term Track</Label>
                  <Select value={feeTermId} onValueChange={setFeeTermId} required disabled={!feeSessionId}>
                    <SelectTrigger id="feeTerm">
                      <SelectValue placeholder="Choose Term" />
                    </SelectTrigger>
                    <SelectContent>
                      {feeTermOptions.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="feeClass">Target Student Bracket</Label>
                <Select value={feeClass} onValueChange={setFeeClass} required>
                  <SelectTrigger id="feeClass">
                    <SelectValue placeholder="Choose Bracket Classification" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Classes (Flat Levy)</SelectItem>
                    {NIGERIAN_CLASSES.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {loadingExistingFees ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm text-muted-foreground ml-2">Loading template details...</span>
                </div>
              ) : (
                <div className="space-y-3 mt-2 border-t pt-4">
                  <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Item Breakdown Layout (Enter Amount in ₦)</Label>
                  {feeEntries.map((entry, index) => (
                    <div key={index} className="grid grid-cols-3 items-center gap-2">
                      <Label className="col-span-1 text-sm truncate flex items-center gap-1" title={entry.name}>
                        {entry.name}
                      </Label>
                      <div className="col-span-2 relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₦</span>
                        <Input
                          type="number"
                          placeholder="0.00"
                          className="pl-7"
                          value={entry.amount}
                          disabled={entry.locked}
                          onChange={(e) => {
                            const updated = [...feeEntries];
                            updated[index].amount = e.target.value;
                            setFeeEntries(updated);
                          }}
                        />
                        {entry.locked && (
                          <Badge
                            variant="outline"
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] bg-muted text-muted-foreground"
                          >
                            Published — locked
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter className="p-6 pt-2 shrink-0 border-t bg-muted/20">
              <Button type="button" variant="outline" onClick={() => setAddFeeOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addingFee || loadingExistingFees}>
                {addingFee ? "Saving..." : "Submit for Approval"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SchoolAdminDashboard;