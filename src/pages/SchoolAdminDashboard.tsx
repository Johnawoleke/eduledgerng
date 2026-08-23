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
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  ChevronsUp,
  MoreHorizontal,
  ArrowUpDown, ArrowUp
} from "lucide-react";
import { generateReceiptPdf, parsePaymentItems } from "@/lib/generateReceiptPdf";
import { buildStatement, statementToCsv } from "@/lib/studentStatement";
import { parseRosterRows, describeRejections, rejectedRowsCsv, rosterTemplateCsv } from "@/lib/rosterImport";
import { generateStatementPdf } from "@/lib/generateStatementPdf";
import { isSettledPayment } from "@/lib/paymentStatus";
import {
  NIGERIAN_CLASSES, OUTCOME_LABEL, nextClass,
  type PromotionAction,
} from "@/lib/classes";
import { createSessionWithTerms, ensureSessionHasTerms } from "@/lib/academicSessions";
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
  action: PromotionAction;
  to_class: string | null;
  reason: string;
  outstanding: number;
  already_enrolled: boolean;
}

interface PromotionPreview {
  from_session: string;
  to_session: string;
  /** What the school will graduate at. Declared by the school, or suggested. */
  final_class: string | null;
  final_class_is_declared: boolean;
  suggested_final_class: string | null;
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
  // Which class the move is scoped to, or null for the whole school. A school
  // owner reaches this from a class, so the class-scoped run is the common one.
  const [promoteOnlyClass, setPromoteOnlyClass] = useState<string | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<string>("");
  const [promotePreview, setPromotePreview] = useState<PromotionPreview | null>(null);
  const [promoteBusy, setPromoteBusy] = useState(false);
  // The school's decisions, defaulted from the preview and edited here. commit
  // applies exactly these rather than recomputing, which is what makes repeats
  // and one-off placements expressible at all.
  const [promoteDecisions, setPromoteDecisions] = useState<Record<string, { action: PromotionAction; to_class: string | null }>>({});
  const [finalClassDraft, setFinalClassDraft] = useState<string>("");
  const [lastRollover, setLastRollover] = useState<{ batch: string; from: string; to: string } | null>(null);
  const [makeCurrent, setMakeCurrent] = useState(false);
  const [classEditFor, setClassEditFor] = useState<string | null>(null);
  const [classEditBusy, setClassEditBusy] = useState(false);
  const [payments, setPayments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  // "ALL" by default. Defaulting to one class meant a school with nobody in JSS1
  // opened its own roster to "No students found", which reads as data loss.
  const [studentsClassFilter, setStudentsClassFilter] = useState("ALL");
  const [showArchived, setShowArchived] = useState(false);
  const [paymentsClassFilter, setPaymentsClassFilter] = useState("ALL");
  const [selectedStudent, setSelectedStudent] = useState<StudentRow | null>(null);
  const [statementFor, setStatementFor] = useState<string | null>(null);
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

  // "graduated" joins archived/inactive as off-the-roster. A leaver who stays
  // listed sits in their old class forever, indistinguishable from a student
  // still being taught there — and gets counted in that class's fee totals.
  // Their record and history are untouched; they are simply no longer current.
  const classEditStudent = students.find((s) => s.id === classEditFor) || null;

  const isArchived = (s: StudentRow) =>
    s.status === "archived" || s.status === "inactive" || s.status === "graduated";
  const activeStudents = students.filter((s) => !isArchived(s));
  const archivedStudents = students.filter((s) => isArchived(s));

  // EVERY class, in ladder order, with head counts — not just the ones with
  // pupils in them.
  //
  // This used to filter to `count > 0` to keep the row short. That saved a line
  // of screen and cost the school the thing the list is actually for: a new
  // school sees the classes it has not set up yet and knows to add them, and an
  // existing one can tell an empty class from a class that is not offered. The
  // owner's words: "let it be there so once they login they'll see the need to
  // add the other classes."
  const headCount = (name: string) => activeStudents.filter((s) => s.class === name).length;
  const classCounts = new Map(NIGERIAN_CLASSES.map((name) => [name as string, headCount(name)]));
  const selectedClassCount =
    studentsClassFilter === "ALL" ? activeStudents.length : (classCounts.get(studentsClassFilter) || 0);


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

  // Who owes what, and in which term — grouped student, then period, then fee.
  //
  // Deliberately ignores the period selector. A debt carried from an earlier
  // term is exactly the thing you cannot see by filtering to the current one,
  // so a view built on that filter can never show it. Before this, the only way
  // to find it was to already know which term to go looking in.
  const debtors = (() => {
    const byStudent = new Map<string, {
      student: StudentRow;
      total: number;
      periods: Map<string, { label: string; owing: number; fees: { name: string; amount: number; paid: number; owing: number }[] }>;
    }>();

    for (const c of charges) {
      const student = students.find((s) => s.id === c.student_id);
      if (!student || isArchived(student)) continue;

      const fee = feeById.get(c.class_fee_id);
      const paid = Math.min(
        sumPaidForFee(
          allSettledPayments.filter((p) => p.student_id === c.student_id),
          { id: c.class_fee_id, name: fee?.name ?? "" }
        ),
        Number(c.amount)
      );
      const owing = Math.max(Number(c.amount) - paid, 0);
      if (owing <= 0) continue;

      const sessionName = academicPeriods.sessions.find((x) => x.id === c.session_id)?.name;
      const termName = academicPeriods.terms.find((x) => x.id === c.term_id)?.name;
      const label = [sessionName, termName].filter(Boolean).join(" · ") || "Unassigned period";
      const key = `${c.session_id ?? ""}|${c.term_id ?? ""}`;

      const entry = byStudent.get(c.student_id) || { student, total: 0, periods: new Map() };
      entry.total += owing;
      const period = entry.periods.get(key) || { label, owing: 0, fees: [] };
      period.owing += owing;
      period.fees.push({ name: fee?.name ?? "Fee", amount: Number(c.amount), paid, owing });
      entry.periods.set(key, period);
      byStudent.set(c.student_id, entry);
    }

    return [...byStudent.values()]
      .map((e) => ({ ...e, periods: [...e.periods.values()].sort((a, b) => a.label.localeCompare(b.label)) }))
      .sort((a, b) => b.total - a.total);
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

  // Counts follow the school's DECISIONS, not the computed defaults, so the
  // headline numbers change as rows are edited.
  const decisionCounts = (() => {
    const c: Record<string, number> = {
      promote: 0, on_trial: 0, repeat: 0, graduate: 0, archive: 0, unknown: 0,
    };
    for (const p of promotePreview?.plans || []) {
      const d = promoteDecisions[p.student_id];
      c[(d?.action ?? p.action) as string] = (c[(d?.action ?? p.action) as string] || 0) + 1;
    }
    return c;
  })();
  const owingCount = (promotePreview?.plans || []).filter((p) => p.outstanding > 0).length;
  const owingTotal = (promotePreview?.plans || []).reduce((a, p) => a + p.outstanding, 0);

  // Open the move dialog for one class. Nothing is read or written until the
  // school picks the session and asks to see what will happen.
  const openClassPromotion = (className: string) => {
    setPromoteOnlyClass(className);
    setPromotePreview(null);
    setPromoteDecisions({});
    setPromoteOpen(true);
  };

  const setDecision = (studentId: string, action: PromotionAction, fromClass: string) => {
    setPromoteDecisions((prev) => ({
      ...prev,
      [studentId]: {
        action,
        // Repeating means the same class; leaving means none. Moving up
        // defaults to the next rung, and stays editable.
        to_class:
          action === "repeat" ? fromClass
          : action === "graduate" || action === "archive" ? null
          : nextClass(fromClass),
      },
    }));
  };

  // The final class is a property of the school, so it is saved on the school
  // rather than passed per rollover.
  const saveFinalClass = async () => {
    if (!school || !finalClassDraft) return;
    const { error } = await supabase
      .from("schools")
      .update({ settings: { ...(school.settings || {}), final_class: finalClassDraft } })
      .eq("id", school.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Students in ${finalClassDraft} will be marked as finishing school.`);
    await runPromotion("preview");
    loadData();
  };

  const undoRollover = async () => {
    if (!school || !lastRollover) return;
    setPromoteBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("promote-session", {
        body: {
          school_id: school.id,
          from_session_id: lastRollover.from,
          rollover_batch: lastRollover.batch,
          mode: "undo",
        },
      });
      const message = error || data?.error
        ? data?.error || (await readFunctionsError(error, "Could not undo"))
        : null;
      if (message) { toast.error(message, { duration: 10000 }); return; }
      toast.success(`Undone. ${data.reversed} student(s) put back.`);
      setLastRollover(null);
      await academicPeriods.reload();
      loadData();
    } finally {
      setPromoteBusy(false);
    }
  };

  // --- Year-end rollover ---------------------------------------------------
  //
  // The target session must be a REAL row: the picker also offers virtual
  // "future-<year>" sessions, which are not UUIDs and would 22P02 every query
  // in the function. If one is chosen, create it for real first.
  const resolveTargetSession = async (chosen: string): Promise<string | null> => {
    if (!chosen.startsWith("future-")) {
      // An existing session can predate session-and-terms being one operation
      // and have none, in which case the school could never set a fee for the
      // year it just promoted everyone into.
      if (school) {
        const problem = await ensureSessionHasTerms(school.id, chosen);
        if (problem) {
          toast.error(`That session has no terms and they could not be added: ${problem}`);
          return null;
        }
        await academicPeriods.reload();
      }
      return chosen;
    }
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
          only_class: promoteOnlyClass,
          // commit applies exactly what the school decided. Sending the whole
          // list, defaults included, means the server never has to guess which
          // rows were reviewed.
          ...(mode === "commit"
            ? {
                make_current: makeCurrent,
                decisions: (promotePreview?.plans || []).map((p) => {
                  const d = promoteDecisions[p.student_id];
                  return {
                    student_id: p.student_id,
                    action: d?.action ?? p.action,
                    to_class: d?.to_class ?? p.to_class,
                  };
                }),
              }
            : {}),
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
        setPromoteDecisions({});
        setFinalClassDraft(data.final_class || "");
      } else {
        const a = data.applied;
        toast.success(
          (data.only_class ? `${data.only_class}: ` : "") +
            `${a.promoted} moved up` +
            (a.on_trial ? `, ${a.on_trial} on trial` : "") +
            (a.repeated ? `, ${a.repeated} staying put` : "") +
            (a.graduated ? `, ${a.graduated} finishing` : "") +
            (a.archived ? `, ${a.archived} archived` : "") +
            "." +
            (a.left_alone_unknown_class
              ? ` ${a.left_alone_unknown_class} left alone (class not recognised).`
              : ""),
          { duration: 8000 }
        );
        // Keep the batch so it can be undone without hunting for it.
        setLastRollover({
          batch: data.rollover_batch,
          from: academicPeriods.selectedSessionId as string,
          to: targetId,
        });
        setPromoteOpen(false);
        setPromotePreview(null);
        setPromoteOnlyClass(null);
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
    // Built in rosterImport from the same class list the parser accepts, so the
    // template can never demonstrate a class the upload would then reject. It
    // was three hand-written lines here and had already drifted once:
    // parent_email was added to the parser and not to the template, so no
    // roster built from it could carry one — and a student with no parent
    // email gets a receipt that bounces.
    const csv = rosterTemplateCsv();
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

      // Validate every row and keep the reasons. The old code did
      // .map(...).filter(Boolean), so a rejected row simply disappeared: a
      // school uploading 99 children was told "no valid rows found" with no
      // mention of which class names were the problem, and a partially valid
      // file reported only the successes.
      const { accepted, rejected } = parseRosterRows(normalizedRows);

      const offerRejectedCsv = () => {
        const blob = new Blob([rejectedRowsCsv(rejected)], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "rows-we-could-not-add.csv";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };

      if (accepted.length === 0) {
        toast.error(`None of the ${rejected.length} row(s) could be added`, {
          description: `${describeRejections(rejected)} Classes must be one of: ${NIGERIAN_CLASSES.join(", ")}.`,
          position: "top-center",
          duration: Infinity,
          closeButton: true,
          action: rejected.length
            ? { label: "Download details", onClick: (e) => { e.preventDefault(); offerRejectedCsv(); } }
            : undefined,
        });
        return;
      }

      const inserts = accepted.map((r) => {
        const nameParts = toStudentNameParts(r.name);
        // A distinct temporary password per row — a shared one would put the
        // whole uploaded roster behind a single guess.
        const tempPassword = generateTempPassword();
        return {
          school_id: school.id,
          student_id: generateStudentCode(nameParts.surname, nameParts.firstName, nameParts.middleName),
          name: nameParts.fullName,
          class: r.className,
          pin: tempPassword,
          default_pin: tempPassword,
          must_change_pin: true,
          status: "active",
          parent_email: r.parentEmail,
        };
      });

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

      // A partial upload must say so. Reporting only the successes is how 49
      // missing children go unnoticed.
      if (rejected.length > 0) {
        toast.warning(`${rejected.length} row(s) could not be added`, {
          description: describeRejections(rejected),
          position: "top-center",
          duration: Infinity,
          closeButton: true,
          action: { label: "Download details", onClick: (e) => { e.preventDefault(); offerRejectedCsv(); } },
        });
      }

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

  // A student's complete financial record, every year, as PDF or CSV.
  //
  // Enrolments are fetched on demand rather than loaded with the roster: they
  // are only needed here, and a school with 400 students would otherwise pull
  // thousands of rows on every dashboard load to serve a button most sessions
  // never press.
  const downloadStatement = async (student: StudentRow, format: "pdf" | "csv") => {
    if (!school) return;
    setStatementFor(student.id);
    try {
      const [{ data: enrolments }, { data: studentCharges }] = await Promise.all([
        supabase
          .from("student_enrolments")
          .select("session_id, class, status")
          .eq("school_id", school.id)
          .eq("student_id", student.id),
        supabase
          .from("student_charges")
          .select("class_fee_id, amount, session_id, term_id")
          .eq("school_id", school.id)
          .eq("student_id", student.id),
      ]);

      const statement = buildStatement({
        student: {
          id: student.id,
          student_id: student.student_id,
          name: student.name,
          class: student.class,
          status: student.status,
          parent_email: student.parent_email,
        },
        school: {
          name: school.name,
          address: (school as any).address,
          phone: (school as any).phone,
          email: (school as any).email,
        },
        enrolments: enrolments || [],
        charges: studentCharges || [],
        // Every payment for this student, across all periods — a statement is
        // not filtered by the dashboard's selected term.
        payments: payments.filter((p: any) => p.student_id === student.id),
        fees: classFees.map((f) => ({ id: f.id, name: f.name })),
        sessions: academicPeriods.sessions.map((x) => ({ id: x.id, name: x.name })),
        terms: academicPeriods.terms.map((t) => ({
          id: t.id, name: t.name, session_id: t.session_id, term_number: t.term_number,
        })),
      });

      if (format === "pdf") {
        generateStatementPdf(statement);
      } else {
        const blob = new Blob([statementToCsv(statement)], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `statement-${student.student_id.replace(/[^A-Za-z0-9-]/g, "")}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      toast.success(`Statement downloaded for ${student.name}`);
    } catch (err) {
      console.error("Statement export failed:", err);
      toast.error("Could not build the statement. Please try again.");
    } finally {
      setStatementFor(null);
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
        const matchClass = studentsClassFilter === "ALL" || s.class === studentsClassFilter;
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
          {/* Two daily actions stay in the open; everything occasional moves
              behind one menu. Eight equal-weight buttons over two rows gave a
              once-a-year action that rewrites every student's class the same
              prominence as adding one student, which is both cluttered and
              risky. */}
          <Button
            onClick={() => setAddStudentOpen(true)}
            className="gap-2"
            disabled={academicPeriods.isFutureSession}
            title={academicPeriods.isFutureSession ? "Upcoming sessions cannot be edited yet" : undefined}
          >
            <UserPlus className="w-4 h-4" /> Add Student
          </Button>
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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <MoreHorizontal className="w-4 h-4" /> More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>Students</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={uploadingStudents || academicPeriods.isFutureSession}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-4 h-4 mr-2" />
                {uploadingStudents ? "Uploading..." : "Upload roster (CSV/Excel)"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={downloadStudentTemplate}>
                <Download className="w-4 h-4 mr-2" /> Download roster template
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              <DropdownMenuLabel>Money</DropdownMenuLabel>
              <DropdownMenuItem onClick={exportReport}>
                <FileSpreadsheet className="w-4 h-4 mr-2" /> Who owes (CSV)
              </DropdownMenuItem>

              {userRole === "owner" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>School</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setAddBursarOpen(true)}>
                    <UserCog className="w-4 h-4 mr-2" /> Add bursar
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>End of year</DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={academicPeriods.isFutureSession}
                    onClick={() => { setPromotePreview(null); setPromoteOpen(true); }}
                  >
                    <ChevronsUp className="w-4 h-4 mr-2" /> Move everyone up a class
                  </DropdownMenuItem>
                  {/* Standard SIS practice is to snapshot before a rollover and
                      restore if something surfaces. A shared database cannot be
                      snapshotted, so the equivalent is that the last one stays
                      reversible — and stays visible while it is. */}
                  {lastRollover && (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      disabled={promoteBusy}
                      onClick={undoRollover}
                    >
                      <ArchiveRestore className="w-4 h-4 mr-2" /> Undo last promotion
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
            <TabsTrigger value="owing" className="gap-1.5">
              Owing
              {debtors.length > 0 && (
                <Badge variant="destructive" className="h-4 min-w-4 px-1 text-[10px]">{debtors.length}</Badge>
              )}
            </TabsTrigger>
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
                    </div>
                    {/* Every year, not just the period on screen. A leaver or an
                        auditor asks for the whole history, and until now that
                        meant querying the database by hand. */}
                    <div className="ml-auto flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={statementFor === selectedStudent.id}
                        onClick={() => downloadStatement(selectedStudent, "pdf")}
                      >
                        <Download className="w-3.5 h-3.5" />
                        {statementFor === selectedStudent.id ? "Preparing..." : "Statement (PDF)"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={statementFor === selectedStudent.id}
                        onClick={() => downloadStatement(selectedStudent, "csv")}
                      >
                        CSV
                      </Button>
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
                  <div className="space-y-3 pb-4 border-b">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                      <Button
                        variant={studentsClassFilter === "ALL" ? "default" : "ghost"}
                        size="sm"
                        onClick={() => setStudentsClassFilter("ALL")}
                      >
                        All classes {activeStudents.length > 0 && `(${activeStudents.length})`}
                      </Button>
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

                    {/* Every class, one wrapping row, in ladder order. This is
                        the shape the page had before head counts were added, and
                        it reads as a row of choices rather than a table of data
                        — banding it by Nursery/Primary/JSS/SSS put four captions
                        and a column of zeros on screen and made it look like a
                        report. A class with nobody in it is dimmed rather than
                        hidden: still there to be clicked, but it does not
                        compete with the classes that have pupils in them. */}
                    <div className="flex flex-wrap gap-1 items-center">
                      {NIGERIAN_CLASSES.map((name) => {
                        const count = classCounts.get(name) || 0;
                        const selected = studentsClassFilter === name;
                        return (
                          <Button
                            key={name}
                            variant={selected ? "default" : "ghost"}
                            size="sm"
                            className={!selected && count === 0 ? "text-muted-foreground/50" : ""}
                            onClick={() => setStudentsClassFilter(name)}
                            title={count === 0 ? `No pupils in ${name} yet` : `${count} in ${name}`}
                          >
                            {name}
                            <span className="ml-1.5 text-xs opacity-60">{count}</span>
                          </Button>
                        );
                      })}
                    </div>

                    {/* Move one class up. The owner's mental model is the class,
                        not the school: open Primary 3, move Primary 3 up. */}
                    {studentsClassFilter !== "ALL" && !showArchived && userRole === "owner" && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          disabled={academicPeriods.isFutureSession || selectedClassCount === 0}
                          onClick={() => openClassPromotion(studentsClassFilter)}
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                          {nextClass(studentsClassFilter)
                            ? `Move ${studentsClassFilter} up to ${nextClass(studentsClassFilter)}`
                            : `Finish ${studentsClassFilter}`}
                        </Button>
                        {selectedClassCount === 0 && (
                          <span className="text-xs text-muted-foreground">
                            Nobody in {studentsClassFilter} yet — add a pupil to this class first.
                          </span>
                        )}
                      </div>
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
                                      {/* Not printed into the roster any more. Every
                                          un-rotated student's password was on screen at
                                          once, readable by anyone stood behind the desk
                                          or looking at a shared screen. Copy hands it
                                          over without ever displaying it. */}
                                      <button
                                        type="button"
                                        className="underline underline-offset-2 hover:text-foreground"
                                        onClick={() => {
                                          navigator.clipboard?.writeText(student.default_pin || "");
                                          toast.success(`Temporary password for ${student.name} copied`);
                                        }}
                                      >
                                        Copy temporary password
                                      </button>
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
                                          Fees
                                        </Button>
                                        {/* One menu per student, with everything you can do TO that
                                            student named in words. Changing a class used to live
                                            inside the fees panel, so correcting a typo meant opening
                                            a screen about money; and reset/archive were unlabelled
                                            icons you had to hover to identify. */}
                                        {userRole === "owner" && (
                                          <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                              <Button variant="ghost" size="icon" title={`Actions for ${student.name}`}>
                                                <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
                                              </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-52">
                                              <DropdownMenuLabel className="truncate">{student.name}</DropdownMenuLabel>
                                              <DropdownMenuSeparator />
                                              <DropdownMenuItem
                                                onClick={() => setClassEditFor(student.id)}
                                                disabled={academicPeriods.isFutureSession}
                                              >
                                                <ArrowUpDown className="w-4 h-4 mr-2" /> Change class
                                              </DropdownMenuItem>
                                              <DropdownMenuItem onClick={() => handleViewStudent(student)}>
                                                <Wallet className="w-4 h-4 mr-2" /> View fees
                                              </DropdownMenuItem>
                                              <DropdownMenuSeparator />
                                              <DropdownMenuItem onClick={() => handleResetPassword(student.id, student.name)}>
                                                <KeyRound className="w-4 h-4 mr-2" /> Reset password
                                              </DropdownMenuItem>
                                              <DropdownMenuItem
                                                className="text-destructive focus:text-destructive"
                                                onClick={() => handleArchiveStudent(student.id, student.name)}
                                              >
                                                <Archive className="w-4 h-4 mr-2" /> Archive student
                                              </DropdownMenuItem>
                                            </DropdownMenuContent>
                                          </DropdownMenu>
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

          {/* Who owes what, across every term. This tab ignores the period
              selector on purpose: filtering to the current term is precisely
              what hides a debt carried from an earlier one. */}
          <TabsContent value="owing">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">Who owes, across all terms</CardTitle>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {debtors.length === 0
                        ? "Nobody is owing."
                        : `${formatNaira(owingGrandTotal)} from ${debtors.length} student${debtors.length === 1 ? "" : "s"}. Not affected by the session or term above.`}
                    </p>
                  </div>
                  {debtors.length > 0 && (
                    <Button variant="outline" size="sm" onClick={exportReport} className="gap-2 shrink-0">
                      <FileSpreadsheet className="w-4 h-4" /> Download CSV
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {debtors.length === 0 ? (
                  <p className="text-center text-muted-foreground py-10">
                    Every student is up to date.
                  </p>
                ) : (
                  <div className="border rounded-lg divide-y">
                    {debtors.map(({ student, total, periods }) => (
                      <div key={student.id} className="p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium truncate">{student.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {student.student_id} · {student.class}
                              {student.parent_email ? ` · ${student.parent_email}` : ""}
                            </p>
                          </div>
                          <p className="font-semibold text-destructive shrink-0">{formatNaira(total)}</p>
                        </div>

                        {/* The breakdown is the point: which TERM the money is
                            owed for, not just how much. */}
                        <div className="mt-2 space-y-1.5">
                          {periods.map((p) => (
                            <div key={p.label} className="rounded-md bg-muted/40 px-2.5 py-1.5">
                              <div className="flex items-center justify-between gap-2 text-sm">
                                <span className="font-medium">{p.label}</span>
                                <span>{formatNaira(p.owing)}</span>
                              </div>
                              <div className="mt-0.5 space-y-0.5">
                                {p.fees.map((f, i) => (
                                  <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                    <span className="truncate">
                                      {f.name}
                                      {f.paid > 0 && ` — ${formatNaira(f.paid)} of ${formatNaira(f.amount)} paid`}
                                    </span>
                                    <span className="shrink-0">{formatNaira(f.owing)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
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
        onOpenChange={(o) => {
          setPromoteOpen(o);
          if (!o) { setPromotePreview(null); setPromoteOnlyClass(null); }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {promoteOnlyClass
                ? nextClass(promoteOnlyClass)
                  ? `Move ${promoteOnlyClass} up to ${nextClass(promoteOnlyClass)}`
                  : `Finish ${promoteOnlyClass}`
                : "Move students up a class"}
            </DialogTitle>
            <DialogDescription>
              {promoteOnlyClass ? (
                <>
                  {/* Once the preview is back, the count comes from it, not
                      from the roster. Mid-rollover they differ: a pupil moved
                      up from the class below already shows in this class, and
                      is NOT moving again. Quoting the roster number here would
                      promise to move pupils the move will correctly skip. */}
                  The {promotePreview ? promotePreview.plans.length : selectedClassCount} pupil(s)
                  in {promoteOnlyClass} move up together. Anyone who should not move — because of
                  their result, or because they are leaving — can be changed one by one before you
                  confirm. Nothing changes until you confirm.
                </>
              ) : (
                <>
                  Everyone in {academicPeriods.selectedSession?.name || "this session"} moves up one
                  class. Students in your highest class finish and are marked as leavers. Nothing
                  changes until you confirm.
                </>
              )}
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
              {/* The final class decides who leaves. Inferring it from the
                  roster graduates the wrong people whenever the top class
                  happens to be empty — an ordinary situation in a school still
                  growing upward — so the school states it once. */}
              {/* On a class-scoped move this only matters when the class being
                  moved reaches the school's last year — otherwise it is a
                  school-wide setting asked at the wrong moment, and answering it
                  wrongly graduates a whole class. */}
              {!(promoteOnlyClass && promotePreview.final_class_is_declared && decisionCounts.graduate === 0) && (
              <div className="p-3 rounded-lg border space-y-2">
                <Label className="text-sm">Your highest class (students here finish school)</Label>
                <div className="flex items-center gap-2">
                  <Select value={finalClassDraft} onValueChange={setFinalClassDraft}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Choose" /></SelectTrigger>
                    <SelectContent>
                      {NIGERIAN_CLASSES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" disabled={promoteBusy || !finalClassDraft}
                          onClick={saveFinalClass}>
                    Save
                  </Button>
                </div>
                {!promotePreview.final_class_is_declared && (
                  <p className="text-xs text-muted-foreground">
                    Guessed from your current students. Confirm it before promoting, or students
                    in your top class may be marked as leaving by mistake.
                  </p>
                )}
              </div>
              )}

              <div className="grid grid-cols-5 gap-2 text-center">
                {([
                  ["promote", decisionCounts.promote],
                  ["on_trial", decisionCounts.on_trial],
                  ["repeat", decisionCounts.repeat],
                  ["graduate", decisionCounts.graduate],
                  ["archive", decisionCounts.archive],
                ] as const).map(([k, n]) => (
                  <div key={k} className="p-2 rounded-lg border">
                    <p className="text-xl font-bold">{n}</p>
                    <p className="text-[11px] text-muted-foreground leading-tight">
                      {OUTCOME_LABEL[k as PromotionAction]}
                    </p>
                  </div>
                ))}
              </div>

              {decisionCounts.unknown > 0 && (
                <div className="p-3 rounded-lg border border-destructive/40 bg-destructive/5 text-sm">
                  <p className="font-medium">
                    {decisionCounts.unknown} student(s) are in a class we do not recognise
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    They will be left exactly as they are. Give them a class first if they should move.
                  </p>
                </div>
              )}
              {owingCount > 0 && (
                <div className="p-3 rounded-lg border text-sm">
                  <p className="font-medium">
                    {owingCount} student(s) still owe {formatNaira(owingTotal)}
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    They still move up, and what they owe stays on their record.
                  </p>
                </div>
              )}

              {/* Every row is editable. The default is what the ladder says;
                  the school changes what it disagrees with. */}
              <div className="border rounded-lg divide-y max-h-72 overflow-y-auto">
                {promotePreview.plans.map((p) => {
                  const d = promoteDecisions[p.student_id] || { action: p.action, to_class: p.to_class };
                  return (
                    <div key={p.student_id} className="p-2.5 text-sm space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{p.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {p.student_code} · {p.from_class}
                            {p.outstanding > 0 && ` · owes ${formatNaira(p.outstanding)}`}
                          </p>
                        </div>
                        <Select
                          value={d.action}
                          onValueChange={(v) => setDecision(p.student_id, v as PromotionAction, p.from_class)}
                        >
                          <SelectTrigger className="h-8 w-44 text-xs shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(["promote", "on_trial", "repeat", "graduate", "archive"] as const).map((a) => (
                              <SelectItem key={a} value={a}>{OUTCOME_LABEL[a]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {(d.action === "promote" || d.action === "on_trial") && (
                        <div className="flex items-center gap-2 pl-1">
                          <span className="text-xs text-muted-foreground">Into</span>
                          <Select
                            value={d.to_class || ""}
                            onValueChange={(v) =>
                              setPromoteDecisions((prev) => ({
                                ...prev,
                                [p.student_id]: { action: d.action, to_class: v },
                              }))
                            }
                          >
                            <SelectTrigger className="h-7 w-36 text-xs"><SelectValue placeholder="class" /></SelectTrigger>
                            <SelectContent>
                              {NIGERIAN_CLASSES.map((c) => (
                                <SelectItem key={c} value={c}>{c}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={makeCurrent} onCheckedChange={(v) => setMakeCurrent(!!v)} />
                Make {promotePreview.to_session} the current session now
              </label>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" disabled={promoteBusy}
                        onClick={() => setPromotePreview(null)}>
                  Back
                </Button>
                <Button className="flex-1" disabled={promoteBusy}
                        onClick={() => runPromotion("commit")}>
                  {promoteBusy ? "Working..." : "Apply these changes"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Change class. A dialog rather than a control inside the fees panel:
          correcting a mistyped class should not require opening a screen about
          money, and it has to be reachable from the roster row. */}
      <Dialog open={!!classEditFor} onOpenChange={(o) => { if (!o) setClassEditFor(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Change class</DialogTitle>
            <DialogDescription>
              {classEditStudent
                ? `Move ${classEditStudent.name} for ${academicPeriods.selectedSession?.name || "this session"}. Earlier sessions keep the class they had.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {classEditStudent && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                Currently in <span className="font-medium text-foreground">{classEditStudent.class}</span>
              </div>
              <Select disabled={classEditBusy} onValueChange={(v) => handleChangeClass(classEditStudent.id, v)}>
                <SelectTrigger><SelectValue placeholder="Move to which class?" /></SelectTrigger>
                <SelectContent>
                  {NIGERIAN_CLASSES.filter((c) => c !== classEditStudent.class).map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                This term's fees are re-issued for the new class. If anything has already been
                paid, the change is refused rather than leaving a payment against fees they no
                longer owe.
              </p>
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