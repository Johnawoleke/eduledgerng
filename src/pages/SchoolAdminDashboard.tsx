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

  // Add fee dialog (only for owners)
  const [addFeeOpen, setAddFeeOpen] = useState(false);
  const [feeClass, setFeeClass] = useState("");
  const [feeEntries, setFeeEntries] = useState<{ name: string; amount: string }[]>(
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
  const [bursarPassword, setBursarPassword] = useState("");
  const [bursarConfirmPassword, setBursarConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [addingBursar, setAddingBursar] = useState(false);
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [emailExists, setEmailExists] = useState<boolean | null>(null);

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

  // Update fee term dropdown when fee session changes
  useEffect(() => {
    if (!feeSessionId) return;
    const sessionTerms = academicPeriods.terms.filter((t) => t.session_id === feeSessionId);
    const term1 = sessionTerms.find((t) => t.name === "Term 1") || sessionTerms[0];
    if (term1) setFeeTermId(term1.id);
  }, [feeSessionId, academicPeriods.terms]);

  // Fetch existing fees when session, term, and class are selected
  useEffect(() => {
    const fetchExistingFees = async () => {
      if (!feeSessionId || !feeTermId || !feeClass || !school?.id) {
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
  }, [feeSessionId, feeTermId, feeClass, school?.id]);

  // Filter fees by selected term only
  const filteredClassFees = classFees.filter((f) => {
    if (!academicPeriods.selectedTermId) return true;
    return f.term_id === academicPeriods.selectedTermId;
  });

  // Filter payments by selected term only
  const filteredPaymentsByPeriod = payments.filter((p) => {
    if (!academicPeriods.selectedTermId) return true;
    return p.term_id === academicPeriods.selectedTermId;
  });

  // Helper: get class fees applicable to a student class for the selected term
  const getFeesForClass = (studentClass: string) => {
    return filteredClassFees.filter((f) => {
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
    const applicableFees = filteredClassFees.filter(
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
        const rows = xlsxModule.utils.sheet_to_json<Record<string, string | number>>(sheet, { defval: "" });
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

    const validFees = feeEntries.filter((f) => f.name.trim() && Number(f.amount) > 0);
    if (validFees.length === 0) { toast.error("Add at least one fee with an amount"); return; }

    setAddingFee(true);

    try {
      const upserts = validFees.map((f) => ({
        school_id: school.id,
        class_target: feeClass,
        name: f.name.trim(),
        amount: Number(f.amount),
        session_id: feeSessionId,
        term_id: feeTermId,
      }));

      const { error } = await supabase.from("class_fees").upsert(upserts, {
        onConflict: "school_id,class_target,name,session_id,term_id",
      });

      if (error) {
        toast.error(error.message);
      } else {
        const actionWord = hasExistingFees ? "updated" : "added";
        toast.success(`${validFees.length} fee(s) ${actionWord} for ${feeClass === "ALL" ? "All Classes" : feeClass}!`);
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
        if (error) {
          console.error("Error checking user:", error);
          setEmailExists(false);
        } else {
          setEmailExists(data?.exists || false);
        }
      } catch (err) {
        console.error("Error:", err);
        setEmailExists(false);
      } finally {
        setCheckingEmail(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [bursarEmail]);

  const resetBursarForm = () => {
    setBursarEmail("");
    setBursarPassword("");
    setBursarConfirmPassword("");
    setShowPassword(false);
    setEmailExists(null);
  };

  const handleAddBursar = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!bursarEmail.trim()) {
      toast.error("Please enter an email address");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(bursarEmail.trim())) {
      toast.error("Please enter a valid email address");
      return;
    }

    if (!emailExists) {
      toast.error("User does not exist. Please ask them to sign up first.");
      return;
    }

    setAddingBursar(true);

    try {
      // Get current user ID (who is making the request)
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error("You must be logged in");
        setAddingBursar(false);
        return;
      }

      const { data: schoolData } = await supabase
        .from("schools")
        .select("id")
        .eq("slug", slug!)
        .single();

      if (!schoolData) {
        toast.error("School not found");
        setAddingBursar(false);
        return;
      }

      // Send request via edge function
      const { data, error } = await supabase.functions.invoke("add-bursar", {
        body: {
          email: bursarEmail.trim().toLowerCase(),
          schoolId: schoolData.id,
          role: "bursar",
          requestedById: user.id,
        },
      });

      if (error) {
        let errorMsg = error.message || "Failed to send request";
        try {
          const response = (error as any).context;
          if (response && response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let result = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              result += decoder.decode(value, { stream: true });
            }
            const parsed = JSON.parse(result);
            if (parsed.error) errorMsg = parsed.error;
          }
        } catch (parseErr) { /* fallback */ }
        toast.error(errorMsg);
        setAddingBursar(false);
        return;
      }

      toast.success("Request sent! The bursar will be notified.");
      setAddBursarOpen(false);
      resetBursarForm();
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
  const totalStudents = studentsWithTotals.length;
  const totalCollected = filteredPaymentsByPeriod.reduce((s, p) => s + Number(p.amount), 0);
  const totalFees = studentsWithTotals.reduce((s, st) => s + st.totalFees, 0);
  const outstanding = totalFees - studentsWithTotals.reduce((s, st) => s + st.totalPaid, 0);

  const filteredStudents = studentsWithTotals.filter((s) => {
    const matchClass = s.class === studentsClassFilter;
    const matchSearch = !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.student_id.toLowerCase().includes(search.toLowerCase());
    return matchClass && matchSearch;
  });

  const filteredPayments = filteredPaymentsByPeriod.filter((p) => {
    const studentData = p.students as any;
    const matchClass = paymentsClassFilter === "ALL" || studentData?.class === paymentsClassFilter;
    const matchSearch = !search ||
      (studentData?.name || "").toLowerCase().includes(search.toLowerCase()) ||
      p.reference.toLowerCase().includes(search.toLowerCase());
    return matchClass && matchSearch;
  });

  const formatDateTime = (dateStr: string) => {
    const d = new Date(dateStr);
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
            <Button variant="ghost" size="sm" onClick={handleLogout}>
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
              sessions={academicPeriods.sessions}
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
            disabled={uploadingStudents}
          >
            <Upload className="w-4 h-4" /> {uploadingStudents ? "Uploading..." : "Upload CSV/Excel"}
          </Button>
          <Button variant="outline" onClick={downloadStudentTemplate} className="gap-2">
            <Download className="w-4 h-4" /> Download Template
          </Button>
          <Button onClick={() => setAddStudentOpen(true)} className="gap-2">
            <UserPlus className="w-4 h-4" /> Add Student
          </Button>
          
          {/* Export Report - available to both owners and bursars */}
          <Button variant="outline" onClick={exportReport} className="gap-2">
            <FileSpreadsheet className="w-4 h-4" /> Export Report
          </Button>

          {/* Owner-only actions */}
          {userRole === "owner" && (
            <>
              <Button variant="outline" onClick={() => setAddBursarOpen(true)} className="gap-2">
                <UserCog className="w-4 h-4" /> Add Bursar
              </Button>
              <Button variant="outline" onClick={() => setAddFeeOpen(true)} className="gap-2">
                <Plus className="w-4 h-4" /> {hasExistingFees ? "Update Fee" : "Add Fee"}
              </Button>
            </>
          )}
        </div>

        <Tabs defaultValue="students">
          <TabsList>
            <TabsTrigger value="students">Students</TabsTrigger>
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
                              No students found.
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
                        <TableHead>Amount</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Receipt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPayments.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                            No payments recorded.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredPayments.map((payment) => {
                          const studentData = payment.students as any;
                          return (
                            <TableRow key={payment.id}>
                              <TableCell className="font-mono text-xs">{payment.reference}</TableCell>
                              <TableCell className="font-medium">{studentData?.name || "Unknown Student"}</TableCell>
                              <TableCell>{studentData?.class || "N/A"}</TableCell>
                              <TableCell className="font-semibold text-green-600 dark:text-green-400">
                                {formatNaira(Number(payment.amount))}
                              </TableCell>
                              <TableCell className="text-muted-foreground text-sm">{formatDateTime(payment.date)}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => generateReceiptPdf(payment, school)}
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
              Enter the bursar's email. They must already have an account on EduLedgerNG.
            </DialogDescription>
          </DialogHeader>
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
                        <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">
                          ✗ Not found
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
                {emailExists === false && (
                  <p className="text-xs text-destructive">
                    No account found. Ask the bursar to <Button
                      variant="link"
                      className="p-0 h-auto text-destructive underline"
                      onClick={() => window.open("/register", "_blank")}
                    >
                      sign up
                    </Button> first.
                  </p>
                )}
                {emailExists === true && (
                  <p className="text-xs text-green-600">
                    ✅ Account found! This user will be invited to join your school.
                  </p>
                )}
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
                disabled={addingBursar || !emailExists || checkingEmail}
              >
                {addingBursar ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  "Send Invitation"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Fee Dialog - Owners Only */}
      <Dialog open={addFeeOpen} onOpenChange={setAddFeeOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[85vh] flex flex-col p-0">
          <form onSubmit={handleAddFee} className="flex flex-col h-full overflow-hidden">
            <DialogHeader className="p-6 pb-2 shrink-0">
              <DialogTitle>{hasExistingFees ? "Update Class Term Fees" : "Configure Class Term Fees"}</DialogTitle>
              <DialogDescription>
                {hasExistingFees
                  ? "Fees already exist for this combination. Updating amounts below will overwrite them."
                  : "Assign general billing items and mandatory levies to specific class brackets here."}
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
                      <Label className="col-span-1 text-sm truncate" title={entry.name}>{entry.name}</Label>
                      <div className="col-span-2 relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₦</span>
                        <Input
                          type="number"
                          placeholder="0.00"
                          className="pl-7"
                          value={entry.amount}
                          onChange={(e) => {
                            const updated = [...feeEntries];
                            updated[index].amount = e.target.value;
                            setFeeEntries(updated);
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter className="p-6 pt-2 shrink-0 border-t bg-muted/20">
              <Button type="button" variant="outline" onClick={() => setAddFeeOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addingFee || loadingExistingFees}>
                {addingFee ? "Saving Data..." : hasExistingFees ? "Update Records" : "Publish Fees"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SchoolAdminDashboard;