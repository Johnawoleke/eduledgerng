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
  GraduationCap, 
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
  FileSpreadsheet
} from "lucide-react";
import { generateReceiptPdf, parsePaymentItems } from "@/lib/generateReceiptPdf";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionsError } from "@/lib/utils";
import { useAcademicPeriods } from "@/hooks/useAcademicPeriods";
import AcademicPeriodSelector from "@/components/AcademicPeriodSelector";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);

const NIGERIAN_CLASSES = ["JSS1", "JSS2", "JSS3", "SSS1", "SSS2", "SSS3"];

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
  const [payments, setPayments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [studentsClassFilter, setStudentsClassFilter] = useState("JSS1");
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
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [emailExists, setEmailExists] = useState<boolean | null>(null);
  const [createdCredentials, setCreatedCredentials] = useState<{ email: string; password: string } | null>(null);

  // Staff management (owner only): current members + pending invites
  const [staffMembers, setStaffMembers] = useState<{ user_id: string; role: string; email: string }[]>([]);
  const [pendingInvites, setPendingInvites] = useState<{ id: string; role: string; email: string; expires_at: string }[]>([]);
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
      const { data: invites } = await supabase
        .from("school_requests")
        .select("id, user_id, role, expires_at")
        .eq("school_id", school.id)
        .eq("status", "pending");

      const userIds = [
        ...(admins || []).map((a) => a.user_id),
        ...(invites || []).map((i) => i.user_id),
      ];
      const emailById: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, email")
          .in("id", userIds);
        (profs || []).forEach((p) => { emailById[p.id] = p.email || ""; });
      }

      setStaffMembers(
        (admins || []).map((a) => ({ user_id: a.user_id, role: a.role, email: emailById[a.user_id] || "—" }))
      );
      const now = Date.now();
      setPendingInvites(
        (invites || [])
          .filter((i) => new Date(i.expires_at).getTime() > now)
          .map((i) => ({ id: i.id, role: i.role, email: emailById[i.user_id] || "—", expires_at: i.expires_at }))
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

  const handleCancelInvite = async (inviteId: string, email: string) => {
    setStaffActionId(inviteId);
    const { error } = await supabase.from("school_requests").delete().eq("id", inviteId);
    if (error) {
      toast.error("Failed to cancel invitation");
    } else {
      toast.success(`Invitation to ${email} cancelled`);
      loadStaff();
    }
    setStaffActionId(null);
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

  // Filter payments by selected term only
  const filteredPaymentsByPeriod = academicPeriods.isFutureSession
    ? []
    : payments.filter((p) => {
        if (!academicPeriods.selectedTermId) return true;
        return p.term_id === academicPeriods.selectedTermId;
      });

  // Helper: get published class fees applicable to a student class for the selected term
  const getFeesForClass = (studentClass: string) => {
    return publishedClassFees.filter((f) => {
      return f.class_target === studentClass || f.class_target === "ALL";
    });
  };

  // Helper: calculate paid amount for a fee from filtered payments
  const getPaidForFee = (studentId: string, feeName: string, feeAmount: number) => {
    let totalPaid = 0;
    filteredPaymentsByPeriod
      .filter((p) => p.student_id === studentId)
      .forEach((p) => {
        (p.items || []).forEach((item: string) => {
          const pipeIdx = item.lastIndexOf("|");
          if (pipeIdx > 0) {
            const itemName = item.substring(0, pipeIdx);
            const itemAmount = Number(item.substring(pipeIdx + 1));
            if (itemName === feeName && !isNaN(itemAmount)) {
              totalPaid += itemAmount;
            }
          }
        });
      });
    return Math.min(totalPaid, feeAmount);
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

    // Fetch user's role for this school
    const { data: adminEntry } = await supabase
      .from("school_admins")
      .select("role")
      .eq("school_id", schoolData.id)
      .eq("user_id", user.id)
      .maybeSingle();

    setUserRole(adminEntry?.role || null);

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

    const allClassFees = (classFeesData || []) as ClassFee[];
    setClassFees(allClassFees);
    setPayments(paymentsData || []);

    // Student rows - only include active students
    const studentRows: StudentRow[] = (studentsData || [])
      .filter((s: any) => s.status !== "inactive")
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

  // Recalculate student totals when period filter changes (term-specific)
  const studentsWithTotals = students.map((s) => {
    const applicableFees = publishedClassFees.filter(
      (f) => f.class_target === s.class || f.class_target === "ALL"
    );
    const totalFees = applicableFees.reduce((a, f) => a + Number(f.amount), 0);

    let totalPaid = 0;
    filteredPaymentsByPeriod
      .filter((p) => p.student_id === s.id)
      .forEach((p) => {
        totalPaid += Number(p.amount);
      });

    return { ...s, totalFees, totalPaid: Math.min(totalPaid, totalFees) };
  });

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

    const { error } = await supabase.from("students").insert({
      school_id: school.id,
      student_id: studentId,
      name: fullName,
      class: newStudentClass,
      pin: "Password1",
      default_pin: "Password1",
      must_change_pin: true,
      parent_email: newParentEmail.trim().toLowerCase(),
      status: "active",
    } as any);

    if (error) {
      toast.error(error.message);
    } else {
      toast.success(`Student added! ID: ${studentId}, Default Password: password`);
      setAddStudentOpen(false);
      setNewSurname(""); setNewFirstName(""); setNewMiddleName("");
      setNewStudentClass(""); setNewParentEmail("");
      loadData();
    }
    setAddingStudent(false);
  };

  const handleDeleteStudent = async (studentDbId: string, studentName: string) => {
    // Only owners can delete students
    if (userRole !== "owner") {
      toast.error("Only owners can delete students");
      return;
    }
    if (!confirm(`Are you sure you want to delete ${studentName}? This action cannot be undone.`)) {
      return;
    }

    const { error } = await supabase.from("students").delete().eq("id", studentDbId);

    if (error) {
      toast.error("Failed to delete student");
    } else {
      toast.success(`Student ${studentName} has been deleted`);
      loadData();
    }
  };

  const handleResetPin = async (studentDbId: string, studentName: string) => {
    // Only owners can reset pins
    if (userRole !== "owner") {
      toast.error("Only owners can reset student PINs");
      return;
    }
    const { error } = await supabase.from("students").update({
      pin: "password", default_pin: "password", must_change_pin: true,
    }).eq("id", studentDbId);

    if (error) {
      toast.error("Failed to reset password");
    } else {
      toast.success(`Password reset for ${studentName}. Default: password`);
      loadData();
    }
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
    const csv = ["name,class", "Okafor Chinedu,JSS1", "Adebayo Kemi,SSS2"].join("\n");
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
          const className = rawClass?.toUpperCase().trim();
          if (!rawName || !className || !NIGERIAN_CLASSES.includes(className)) return null;

          const nameParts = toStudentNameParts(rawName);
          return {
            school_id: school.id,
            student_id: generateStudentCode(nameParts.surname, nameParts.firstName, nameParts.middleName),
            name: nameParts.fullName,
            class: className,
            pin: "password",
            default_pin: "password",
            must_change_pin: true,
            status: "active",
          };
        })
        .filter(Boolean) as any[];

      if (inserts.length === 0) {
        toast.error("No valid rows found. Use columns: name and class (JSS1-SSS3).");
        return;
      }

      const { error } = await supabase.from("students").insert(inserts);
      if (error) {
        toast.error(error.message);
        return;
      }

      toast.success(`${inserts.length} student(s) uploaded successfully`);
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
  const handleApproveFee = async (feeId: string) => {
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

  // Debounced email check for bursar
  useEffect(() => {
    if (!bursarEmail.trim()) {
      setEmailExists(null);
      return;
    }

    const timer = setTimeout(async () => {
      setCheckingEmail(true);
      try {
        const { data, error } = await supabase.functions.invoke("check-user-exists", {
          body: { email: bursarEmail.trim().toLowerCase() },
        });
        if (error || data?.error) {
          // Fail CLOSED: leave the state unknown rather than falsely offering
          // "create new account" for an email that might already exist.
          console.error("Error checking user:", error || data?.error);
          setEmailExists(null);
          toast.error("Couldn't verify that email. Please try again.");
        } else {
          setEmailExists(data?.exists ?? null);
        }
      } catch (err) {
        console.error("Error:", err);
        setEmailExists(null);
      } finally {
        setCheckingEmail(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [bursarEmail]);

  // Load current staff + pending invites whenever an owner opens the dialog
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
    setEmailExists(null);
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

    const creating = emailExists === false;
    if (creating) {
      if (bursarPassword.length < 6) {
        toast.error("Password must be at least 6 characters");
        return;
      }
      if (bursarPassword !== bursarConfirmPassword) {
        toast.error("Passwords do not match");
        return;
      }
    } else if (emailExists !== true) {
      toast.error("Please wait for the email check to finish");
      return;
    }

    setAddingBursar(true);

    try {
      const { data, error } = await supabase.functions.invoke("add-bursar", {
        body: {
          email: cleanEmail,
          schoolId: school.id,
          role: "bursar",
          ...(creating
            ? { password: bursarPassword, fullName: bursarFullName.trim() || undefined }
            : {}),
        },
      });

      if (error || data?.error) {
        toast.error(data?.error || (await readFunctionsError(error, "Failed to add bursar")));
        return;
      }

      if (data?.created) {
        // Show the credentials so the owner can share them with the bursar
        setCreatedCredentials({ email: cleanEmail, password: bursarPassword });
        toast.success("Bursar account created and added to this school!");
        loadData();
        loadStaff();
      } else {
        toast.success("Invitation sent! The bursar will see it on their dashboard.");
        setBursarEmail("");
        setBursarFullName("");
        setBursarPassword("");
        setBursarConfirmPassword("");
        setEmailExists(null);
        loadStaff();
      }
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

    const applicableFees = getFeesForClass(student.class);
    const feeBreakdown = applicableFees.map((cf) => {
      const paid = getPaidForFee(student.id, cf.name, Number(cf.amount));
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
  const exportReport = () => {
    // Placeholder for report generation
    toast.info("Report generation will be available soon!");
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
  const totalCollected = filteredPaymentsByPeriod.reduce((s, p) => s + Number(p.amount), 0);
  const totalFees = studentsWithTotals.reduce((s, st) => s + st.totalFees, 0);
  const outstanding = totalFees - studentsWithTotals.reduce((s, st) => s + st.totalPaid, 0);

  // Future sessions are blank everywhere, including the student roster
  const filteredStudents = academicPeriods.isFutureSession
    ? []
    : studentsWithTotals.filter((s) => {
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
        <div className="container mx-auto flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">{school?.name}</span>
            <Badge variant="outline" className="ml-2 text-xs capitalize">
              {userRole || "Admin"}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => navigate("/main-dashboard")} 
              title="Dashboard"
            >
              <Home className="w-4 h-4" />
            </Button>
            {userRole === "owner" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(`/school/${slug}/settings`)}
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => navigate("/change-password")} title="Change password">
              <KeyRound className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout} title="Log out">
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
                  <p className="text-sm text-muted-foreground">Outstanding</p>
                  <p className="text-2xl font-bold">{formatNaira(outstanding)}</p>
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
            <FileSpreadsheet className="w-4 h-4" /> Export Report
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
                    <div>
                      <CardTitle className="text-lg">{selectedStudent.name}</CardTitle>
                      <p className="text-sm text-muted-foreground">{selectedStudent.student_id} · {selectedStudent.class}</p>
                      {selectedStudent.parent_email && (
                        <p className="text-xs text-muted-foreground mt-0.5">Parent: {selectedStudent.parent_email}</p>
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
                                <TableCell className="font-medium">{student.name}</TableCell>
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
                                    <Button variant="ghost" size="sm" onClick={() => handleViewStudent(student)}>
                                      View Fees
                                    </Button>
                                    {/* Only owners can reset PIN and delete */}
                                    {userRole === "owner" && (
                                      <>
                                        <Button variant="ghost" size="icon" onClick={() => handleResetPin(student.id, student.name)} title="Reset Password">
                                          <KeyRound className="w-4 h-4 text-muted-foreground" />
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={() => handleDeleteStudent(student.id, student.name)} title="Delete Student">
                                          <Trash2 className="w-4 h-4 text-destructive" />
                                        </Button>
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
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sessionClassFees.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
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
                                      onClick={() => handleApproveFee(fee.id)}
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
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Receipt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPayments.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                            No payments recorded.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredPayments.map((payment) => {
                          const studentData = payment.students as any;
                          const paidItems = parsePaymentItems(payment.items || []);
                          return (
                            <TableRow key={payment.id}>
                              <TableCell className="font-mono text-xs">{payment.reference}</TableCell>
                              <TableCell className="font-medium">{studentData?.name || "Unknown Student"}</TableCell>
                              <TableCell>{studentData?.class || "N/A"}</TableCell>
                              <TableCell className="text-xs max-w-[220px]">
                                {paidItems.length > 0
                                  ? paidItems.map((i) => i.name).join(", ")
                                  : "—"}
                              </TableCell>
                              <TableCell className="font-semibold text-green-600 dark:text-green-400">
                                {formatNaira(Number(payment.amount))}
                              </TableCell>
                              <TableCell className="text-muted-foreground text-sm">{formatDateTime(payment.date)}</TableCell>
                              <TableCell className="text-right">
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
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle>Add Bursar</DialogTitle>
            <DialogDescription>
              {createdCredentials
                ? "Account created — share these login details with your bursar."
                : "Enter the bursar's email. If they don't have an account yet, you can create one for them."}
            </DialogDescription>
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
            {/* Current staff + pending invitations */}
            {(staffMembers.length > 0 || pendingInvites.length > 0 || loadingStaff) && (
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
                    {pendingInvites.map((inv) => (
                      <div key={inv.id} className="flex items-center justify-between gap-2 text-sm rounded-md border border-dashed px-3 py-2">
                        <div className="min-w-0">
                          <span className="truncate block">{inv.email}</span>
                          <span className="text-xs text-amber-600">Invitation pending</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive shrink-0 h-7"
                          disabled={staffActionId === inv.id}
                          onClick={() => handleCancelInvite(inv.id, inv.email)}
                        >
                          {staffActionId === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Cancel"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          <form onSubmit={handleAddBursar}>
            <div className="grid gap-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="bursarEmail">Add a Bursar — Email *</Label>
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
                  {checkingEmail && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
                  )}
                  {emailExists !== null && !checkingEmail && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      {emailExists ? (
                        <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/30">
                          ✓ Exists
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
                          New account
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
                {emailExists === true && (
                  <p className="text-xs text-green-600">
                    ✅ Account found — this user will be invited and must accept from their dashboard.
                  </p>
                )}
                {emailExists === false && (
                  <p className="text-xs text-muted-foreground">
                    No account exists for this email — fill in a password below to create the
                    bursar's account now and share the details with them.
                  </p>
                )}
              </div>

              {emailExists === false && (
                <>
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
                </>
              )}
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
                  checkingEmail ||
                  emailExists === null ||
                  (emailExists === false && (bursarPassword.length < 6 || bursarPassword !== bursarConfirmPassword))
                }
              >
                {addingBursar ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {emailExists === false ? "Creating..." : "Sending..."}
                  </>
                ) : emailExists === false ? (
                  "Create Bursar Account"
                ) : (
                  "Send Invitation"
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