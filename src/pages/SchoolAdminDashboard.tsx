import React, { useState, useEffect } from "react";
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
import { GraduationCap, LogOut, Users, Wallet, TrendingUp, Search, Plus, UserPlus, Copy, Link as LinkIcon, KeyRound, Trash2, ChevronLeft, Download } from "lucide-react";
import { generateReceiptPdf, parsePaymentItems } from "@/lib/generateReceiptPdf";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);

const NIGERIAN_CLASSES = ["JSS1", "JSS2", "JSS3", "SSS1", "SSS2", "SSS3"];

const DEFAULT_FEE_TEMPLATES = [
  "Tuition Fee",
  "PTA Levy",
  "Exam Fee",
  "Sports Levy",
  "Computer Fee",
  "Library Fee",
  "Laboratory Fee",
  "Books and Materials",
  "Uniform Fee",
  "Development Levy",
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
  totalFees: number;
  totalPaid: number;
}

interface ClassFee {
  id: string;
  school_id: string;
  class_target: string;
  name: string;
  amount: number;
}

const generateStudentCode = (surname: string, firstName: string, middleName: string) => {
  const initials = [surname, firstName, middleName]
    .filter(Boolean)
    .map((n) => n.charAt(0).toUpperCase())
    .join("");
  const num = String(Math.floor(1000 + Math.random() * 9000));
  return `${initials}-${num}`;
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

  // Add student dialog
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [newSurname, setNewSurname] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newMiddleName, setNewMiddleName] = useState("");
  const [newStudentClass, setNewStudentClass] = useState("");
  const [newParentEmail, setNewParentEmail] = useState("");
  const [addingStudent, setAddingStudent] = useState(false);

  // Add fee dialog
  const [addFeeOpen, setAddFeeOpen] = useState(false);
  const [feeClass, setFeeClass] = useState("");
  const [feeEntries, setFeeEntries] = useState<{ name: string; amount: string }[]>(
    DEFAULT_FEE_TEMPLATES.map((name) => ({ name, amount: "" }))
  );
  const [addingFee, setAddingFee] = useState(false);

  // Helper: get class fees applicable to a student class
  const getFeesForClass = (studentClass: string) => {
    return classFees.filter((f) => f.class_target === studentClass || f.class_target === "ALL");
  };

  // Helper: calculate paid amount for a fee from payments
  const getPaidForFee = (studentId: string, feeName: string, feeAmount: number) => {
    let totalPaid = 0;
    payments
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

    const { data: studentsData } = await supabase
      .from("students")
      .select("id, student_id, name, class, term, session, default_pin, must_change_pin, parent_email")
      .eq("school_id", schoolData.id);

    // Fetch class-level fees
    const { data: classFeesData } = await supabase
      .from("class_fees")
      .select("*")
      .eq("school_id", schoolData.id);

    const { data: paymentsData } = await supabase
      .from("payments")
      .select("*, students(name, student_id, class)")
      .eq("school_id", schoolData.id)
      .order("date", { ascending: false });

    const allClassFees = (classFeesData || []) as ClassFee[];
    setClassFees(allClassFees);
    setPayments(paymentsData || []);

    // Calculate totals per student from class fees + payments
    const studentRows: StudentRow[] = (studentsData || []).map((s: any) => {
      const applicableFees = allClassFees.filter(
        (f) => f.class_target === s.class || f.class_target === "ALL"
      );
      const totalFees = applicableFees.reduce((a, f) => a + Number(f.amount), 0);

      let totalPaid = 0;
      (paymentsData || [])
        .filter((p: any) => p.student_id === s.id)
        .forEach((p: any) => {
          totalPaid += Number(p.amount);
        });

      return {
        ...s,
        totalFees,
        totalPaid: Math.min(totalPaid, totalFees),
      };
    });

    studentRows.sort((a, b) => a.name.localeCompare(b.name));

    setStudents(studentRows);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [slug]);

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
      pin: "password",
      default_pin: "password",
      must_change_pin: true,
      parent_email: newParentEmail.trim().toLowerCase(),
    } as any);

    if (error) {
      toast.error(error.message);
    } else {
      toast.success(`Student added! ID: ${studentId}, Default Password: password`);
      setAddStudentOpen(false);
      setNewSurname("");
      setNewFirstName("");
      setNewMiddleName("");
      setNewStudentClass("");
      setNewParentEmail("");
      loadData();
    }
    setAddingStudent(false);
  };

  const handleResetPin = async (studentDbId: string, studentName: string) => {
    const { error } = await supabase.from("students").update({
      pin: "password",
      default_pin: "password",
      must_change_pin: true,
    }).eq("id", studentDbId);

    if (error) {
      toast.error("Failed to reset password");
    } else {
      toast.success(`Password reset for ${studentName}. Default: password`);
      loadData();
    }
  };

  const handleAddFee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feeClass) {
      toast.error("Please select a class");
      return;
    }

    const validFees = feeEntries.filter((f) => f.name.trim() && Number(f.amount) > 0);
    if (validFees.length === 0) {
      toast.error("Add at least one fee with an amount");
      return;
    }

    setAddingFee(true);

    // Insert into class_fees (class-level, not per-student)
    const inserts = validFees.map((f) => ({
      school_id: school.id,
      class_target: feeClass,
      name: f.name.trim(),
      amount: Number(f.amount),
    }));

    const { error } = await supabase.from("class_fees").insert(inserts);

    if (error) {
      toast.error(error.message);
    } else {
      toast.success(`${validFees.length} fee(s) added for ${feeClass === "ALL" ? "All Classes" : feeClass}!`);
      setAddFeeOpen(false);
      setFeeClass("");
      setFeeEntries(DEFAULT_FEE_TEMPLATES.map((name) => ({ name, amount: "" })));
      loadData();
    }
    setAddingFee(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate(`/school/${slug}`);
  };

  const handleViewStudent = async (student: StudentRow) => {
    setSelectedStudent(student);
    setLoadingFees(true);

    // Build fee breakdown from class_fees + payments
    const applicableFees = getFeesForClass(student.class);
    const feeBreakdown = applicableFees.map((cf) => {
      const paid = getPaidForFee(student.id, cf.name, Number(cf.amount));
      const status = paid >= Number(cf.amount) ? "Cleared" : paid > 0 ? "Partial" : "Unpaid";
      return { id: cf.id, name: cf.name, amount: cf.amount, paid, status };
    });

    setStudentFees(feeBreakdown);
    setLoadingFees(false);
  };

  const portalUrl = `${window.location.origin}/school/${slug}`;

  const copyPortalLink = () => {
    navigator.clipboard.writeText(portalUrl);
    toast.success("Portal link copied!");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const totalStudents = students.length;
  const totalCollected = payments.reduce((s, p) => s + Number(p.amount), 0);
  const totalFees = students.reduce((s, st) => s + st.totalFees, 0);
  const outstanding = totalFees - students.reduce((s, st) => s + st.totalPaid, 0);

  const filteredStudents = students.filter((s) => {
    const matchClass = s.class === studentsClassFilter;
    const matchSearch = !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.student_id.toLowerCase().includes(search.toLowerCase());
    return matchClass && matchSearch;
  });

  const filteredPayments = payments.filter((p) => {
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
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            <LogOut className="w-4 h-4" />
          </Button>
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
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search students or references..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button onClick={() => setAddStudentOpen(true)} className="gap-2">
            <UserPlus className="w-4 h-4" /> Add Student
          </Button>
          <Button variant="outline" onClick={() => setAddFeeOpen(true)} className="gap-2">
            <Plus className="w-4 h-4" /> Add Fee
          </Button>
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
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {loadingFees ? (
                    <div className="flex justify-center py-8">
                      <div className="w-6 h-6 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : studentFees.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">No fees set for {selectedStudent.class} yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {studentFees.map((fee: any) => (
                        <div key={fee.id} className="flex items-center justify-between p-3 rounded-lg border">
                          <div>
                            <p className="font-medium">{fee.name}</p>
                            <p className="text-sm text-muted-foreground">{formatNaira(Number(fee.amount))}</p>
                          </div>
                          <Badge variant="outline" className={fee.status === "Cleared" ? "bg-primary/15 text-primary" : fee.status === "Partial" ? "bg-accent/15 text-accent-foreground" : "bg-destructive/10 text-destructive"}>
                            {fee.status}
                            {fee.status === "Partial" && ` — ${formatNaira(Number(fee.paid))} paid`}
                          </Badge>
                        </div>
                      ))}
                      <div className="flex justify-between pt-3 border-t font-medium">
                        <span>Total</span>
                        <span>{formatNaira(studentFees.reduce((a: number, f: any) => a + Number(f.amount), 0))}</span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="flex gap-2 mb-4 flex-wrap">
                  {NIGERIAN_CLASSES.map((c) => (
                    <Button
                      key={c}
                      variant={studentsClassFilter === c ? "default" : "outline"}
                      size="sm"
                      onClick={() => setStudentsClassFilter(c)}
                    >
                      {c}
                    </Button>
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
                            <TableRow key={s.id} className="cursor-pointer" onClick={() => handleViewStudent(s)}>
                              <TableCell className="font-medium">{s.name}</TableCell>
                              <TableCell className="font-mono text-xs">{s.student_id}</TableCell>
                              <TableCell className="text-right">{formatNaira(s.totalPaid)}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className={status === "Cleared" ? "bg-primary/15 text-primary" : status === "Partial" ? "bg-accent/15 text-accent-foreground" : "bg-destructive/10 text-destructive"}>
                                  {status}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        {filteredStudents.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                              No students in {studentsClassFilter}.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          <TabsContent value="payments">
            <div className="flex gap-2 mb-4 flex-wrap">
              <Button
                variant={paymentsClassFilter === "ALL" ? "default" : "outline"}
                size="sm"
                onClick={() => setPaymentsClassFilter("ALL")}
              >
                All
              </Button>
              {NIGERIAN_CLASSES.map((c) => (
                <Button
                  key={c}
                  variant={paymentsClassFilter === c ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPaymentsClassFilter(c)}
                >
                  {c}
                </Button>
              ))}
            </div>
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Student</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead>Fee</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Receipt</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPayments.map((p) => {
                      const studentData = p.students as any;
                      return (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{studentData?.name || "—"}</TableCell>
                          <TableCell><Badge variant="outline">{studentData?.class || "—"}</Badge></TableCell>
                          <TableCell className="text-xs">{p.items?.join(", ") || "—"}</TableCell>
                          <TableCell className="text-right font-medium">{formatNaira(Number(p.amount))}</TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDateTime(p.date)}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1 h-7 text-xs"
                              onClick={() => generateReceiptPdf({
                                schoolName: school?.name || "School",
                                studentName: studentData?.name || "—",
                                studentId: studentData?.student_id || "—",
                                studentClass: studentData?.class || "—",
                                term: "",
                                session: "",
                                reference: p.reference,
                                date: p.date,
                                method: p.method,
                                totalPaid: Number(p.amount),
                                items: parsePaymentItems(p.items || []),
                              })}
                            >
                              <Download className="w-3 h-3" /> PDF
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredPayments.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No payments yet.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Add Student Dialog */}
      <Dialog open={addStudentOpen} onOpenChange={setAddStudentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Student</DialogTitle>
            <DialogDescription>A unique Student ID and PIN will be generated automatically.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddStudent} className="space-y-4">
            <div className="space-y-2">
              <Label>Surname *</Label>
              <Input placeholder="e.g. Okafor" value={newSurname} onChange={(e) => setNewSurname(e.target.value)} maxLength={50} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>First Name *</Label>
                <Input placeholder="e.g. Chinedu" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} maxLength={50} required />
              </div>
              <div className="space-y-2">
                <Label>Middle Name</Label>
                <Input placeholder="e.g. Emmanuel" value={newMiddleName} onChange={(e) => setNewMiddleName(e.target.value)} maxLength={50} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Class *</Label>
              <Select value={newStudentClass} onValueChange={setNewStudentClass}>
                <SelectTrigger><SelectValue placeholder="Select class" /></SelectTrigger>
                <SelectContent>
                  {NIGERIAN_CLASSES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Parent/Guardian Email *</Label>
              <Input type="email" placeholder="e.g. parent@email.com" value={newParentEmail} onChange={(e) => setNewParentEmail(e.target.value)} maxLength={100} required />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={addingStudent}>
                {addingStudent ? "Adding..." : "Add Student"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Fee Dialog */}
      <Dialog open={addFeeOpen} onOpenChange={setAddFeeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Fees</DialogTitle>
            <DialogDescription>Fill in amounts for applicable fees. Remove any that don't apply.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddFee} className="space-y-4">
            <div className="space-y-2">
              <Label>Class</Label>
              <Select value={feeClass} onValueChange={setFeeClass}>
                <SelectTrigger><SelectValue placeholder="Select a class" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Classes</SelectItem>
                  {NIGERIAN_CLASSES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 max-h-[40vh] overflow-y-auto">
              {feeEntries.map((entry, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    placeholder="Fee name"
                    value={entry.name}
                    onChange={(e) => {
                      const updated = [...feeEntries];
                      updated[i] = { ...updated[i], name: e.target.value };
                      setFeeEntries(updated);
                    }}
                    className="flex-1"
                    maxLength={100}
                  />
                  <Input
                    type="number"
                    placeholder="₦ Amount"
                    value={entry.amount}
                    onChange={(e) => {
                      const updated = [...feeEntries];
                      updated[i] = { ...updated[i], amount: e.target.value };
                      setFeeEntries(updated);
                    }}
                    className="w-32"
                    min={0}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setFeeEntries(feeEntries.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFeeEntries([...feeEntries, { name: "", amount: "" }])}
              className="gap-1"
            >
              <Plus className="w-3 h-3" /> Add More
            </Button>
            <DialogFooter>
              <Button type="submit" disabled={addingFee}>
                {addingFee ? "Adding..." : "Add Fees"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SchoolAdminDashboard;
