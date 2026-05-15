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
import { GraduationCap, LogOut, Users, Wallet, TrendingUp, Search, Plus, UserPlus, Copy, Link as LinkIcon, KeyRound, Trash2, ChevronLeft, Download, Settings, Upload } from "lucide-react";
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

// Generate academic years from 2025/2026 through 2035/2036
const generateAcademicYears = () => {
  const years = [];
  for (let year = 2025; year <= 2035; year++) {
    years.push(`${year}/${year + 1}`);
  }
  return years;
};

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

  // Dialog states
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [newSurname, setNewSurname] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newMiddleName, setNewMiddleName] = useState("");
  const [newStudentClass, setNewStudentClass] = useState("");
  const [newParentEmail, setNewParentEmail] = useState("");
  const [addingStudent, setAddingStudent] = useState(false);
  const [uploadingStudents, setUploadingStudents] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [addFeeOpen, setAddFeeOpen] = useState(false);
  const [feeClass, setFeeClass] = useState("");
  const [feeEntries, setFeeEntries] = useState<{ name: string; amount: string }[]>(
    DEFAULT_FEE_TEMPLATES.map((name) => ({ name, amount: "" }))
  );
  const [addingFee, setAddingFee] = useState(false);
  const [feeSessionId, setFeeSessionId] = useState("");
  const [feeTermId, setFeeTermId] = useState("");

  const academicPeriods = useAcademicPeriods(school?.id);

  // Sync sessions automatically
  const syncSessions = async (schoolId: string) => {
    const expectedYears = generateAcademicYears();
    
    // Check what we already have
    const { data: existing } = await supabase
      .from("academic_sessions")
      .select("name")
      .eq("school_id", schoolId);

    const existingNames = existing?.map(e => e.name) || [];
    const missingYears = expectedYears.filter(year => !existingNames.includes(year));

    if (missingYears.length > 0) {
      for (const year of missingYears) {
        const { data: newSession } = await supabase
          .from("academic_sessions")
          .insert({ school_id: schoolId, name: year, is_current: year === "2025/2026" })
          .select()
          .single();

        if (newSession) {
          await supabase.from("academic_terms").insert([
            { session_id: newSession.id, name: "Term 1", is_current: true },
            { session_id: newSession.id, name: "Term 2", is_current: false },
            { session_id: newSession.id, name: "Term 3", is_current: false },
          ]);
        }
      }
    }
  };

  useEffect(() => {
    if (academicPeriods.selectedSessionId && !feeSessionId) {
      setFeeSessionId(academicPeriods.selectedSessionId);
    }
    if (academicPeriods.selectedTermId && !feeTermId) {
      setFeeTermId(academicPeriods.selectedTermId);
    }
  }, [academicPeriods.selectedSessionId, academicPeriods.selectedTermId]);

  const filteredClassFees = classFees.filter((f) => {
    if (!academicPeriods.selectedTermId) return true;
    return f.term_id === academicPeriods.selectedTermId;
  });

  const filteredPaymentsByPeriod = payments.filter((p) => {
    if (!academicPeriods.selectedTermId) return true;
    return p.term_id === academicPeriods.selectedTermId;
  });

  const getFeesForClass = (studentClass: string) => {
    return filteredClassFees.filter((f) => {
      return f.class_target === studentClass || f.class_target === "ALL";
    });
  };

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
    if (!user) { navigate(`/school/${slug}`); return; }

    const { data: schoolData } = await supabase
      .from("schools")
      .select("*")
      .eq("slug", slug!)
      .maybeSingle();

    if (!schoolData) { navigate(`/school/${slug}`); return; }
    setSchool(schoolData);

    // Run the automatic session creator
    await syncSessions(schoolData.id);

    const { data: studentsData } = await supabase
      .from("students")
      .select("*")
      .eq("school_id", schoolData.id);

    const { data: classFeesData } = await supabase
      .from("class_fees")
      .select("*")
      .eq("school_id", schoolData.id);

    const { data: paymentsData } = await supabase
      .from("payments")
      .select("*, students(name, student_id, class)")
      .eq("school_id", schoolData.id)
      .order("date", { ascending: false });

    setClassFees((classFeesData || []) as ClassFee[]);
    setPayments(paymentsData || []);

    const studentRows: StudentRow[] = (studentsData || [])
      .filter((s: any) => s.status !== "inactive")
      .map((s: any) => ({ ...s, totalFees: 0, totalPaid: 0 }));

    studentRows.sort((a, b) => a.name.localeCompare(b.name));
    setStudents(studentRows);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [slug]);

  const studentsWithTotals = students.map((s) => {
    const applicableFees = filteredClassFees.filter(
      (f) => f.class_target === s.class || f.class_target === "ALL"
    );
    const totalFees = applicableFees.reduce((a, f) => a + Number(f.amount), 0);
    let totalPaid = 0;
    filteredPaymentsByPeriod.filter((p) => p.student_id === s.id).forEach((p) => {
      totalPaid += Number(p.amount);
    });
    return { ...s, totalFees, totalPaid: Math.min(totalPaid, totalFees) };
  });

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate(`/school/${slug}`);
  };

  const portalUrl = `${window.location.origin}/school/${slug}`;
  const copyPortalLink = () => { navigator.clipboard.writeText(portalUrl); toast.success("Portal link copied!"); };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const totalStudents = studentsWithTotals.length;
  const totalCollected = filteredPaymentsByPeriod.reduce((s, p) => s + Number(p.amount), 0);
  const totalFeesVal = studentsWithTotals.reduce((s, st) => s + st.totalFees, 0);
  const outstanding = totalFeesVal - studentsWithTotals.reduce((s, st) => s + st.totalPaid, 0);

  const filteredStudents = studentsWithTotals.filter((s) => {
    const matchClass = s.class === studentsClassFilter;
    const matchSearch = !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.student_id.toLowerCase().includes(search.toLowerCase());
    return matchClass && matchSearch;
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">{school?.name}</span>
            <Badge variant="outline" className="ml-2 text-xs">Admin</Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => navigate(`/school/${slug}/settings`)} title="Settings">
              <Settings className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center"><Users className="w-5 h-5 text-primary" /></div><div><p className="text-sm text-muted-foreground">Total Students</p><p className="text-2xl font-bold">{totalStudents}</p></div></div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center"><TrendingUp className="w-5 h-5 text-primary" /></div><div><p className="text-sm text-muted-foreground">Total Collected</p><p className="text-2xl font-bold">{formatNaira(totalCollected)}</p></div></div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center"><Wallet className="w-5 h-5 text-destructive" /></div><div><p className="text-sm text-muted-foreground">Outstanding</p><p className="text-2xl font-bold">{formatNaira(outstanding)}</p></div></div></CardContent></Card>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search students..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button variant="outline" onClick={() => setAddFeeOpen(true)} className="gap-2"><Plus className="w-4 h-4" /> Add Fee</Button>
          <Button onClick={() => setAddStudentOpen(true)} className="gap-2"><UserPlus className="w-4 h-4" /> Add Student</Button>
        </div>

        <Tabs defaultValue="students">
          <TabsList><TabsTrigger value="students">Students</TabsTrigger><TabsTrigger value="payments">Payments</TabsTrigger></TabsList>
          <TabsContent value="students">
            <div className="flex gap-2 mb-4 flex-wrap">
              {NIGERIAN_CLASSES.map((c) => (
                <Button key={c} variant={studentsClassFilter === c ? "default" : "outline"} size="sm" onClick={() => setStudentsClassFilter(c)}>{c}</Button>
              ))}
            </div>
            <Card>
              <CardContent className="pt-6 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Student ID</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredStudents.map((s) => {
                      const status = s.totalFees > 0 && s.totalPaid >= s.totalFees ? "Cleared" : s.totalPaid > 0 ? "Partial" : "Unpaid";
                      return (
                        <TableRow key={s.id}>
                          <TableCell className="font-medium">{s.name}</TableCell>
                          <TableCell className="font-mono text-xs">{s.student_id}</TableCell>
                          <TableCell className="text-right">{formatNaira(s.totalPaid)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={status === "Cleared" ? "bg-primary/10 text-primary" : status === "Partial" ? "bg-amber-100 text-amber-700" : ""}>{status}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default SchoolAdminDashboard;
