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
import { GraduationCap, LogOut, Users, Wallet, TrendingUp, Search, Plus, UserPlus, Copy, Link as LinkIcon, KeyRound, Trash2 } from "lucide-react";
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
  totalFees: number;
  totalPaid: number;
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
  const [payments, setPayments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  // Add student dialog
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [newSurname, setNewSurname] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newMiddleName, setNewMiddleName] = useState("");
  const [newStudentClass, setNewStudentClass] = useState("");
  const [addingStudent, setAddingStudent] = useState(false);

  // Add fee dialog
  const [addFeeOpen, setAddFeeOpen] = useState(false);
  const [feeStudentId, setFeeStudentId] = useState("");
  const [feeEntries, setFeeEntries] = useState<{ name: string; amount: string }[]>(
    DEFAULT_FEE_TEMPLATES.map((name) => ({ name, amount: "" }))
  );
  const [addingFee, setAddingFee] = useState(false);

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
      .select("id, student_id, name, class, term, session, default_pin, must_change_pin")
      .eq("school_id", schoolData.id);

    const { data: feeData } = await supabase
      .from("fee_items")
      .select("student_id, amount, paid")
      .eq("school_id", schoolData.id);

    const { data: paymentsData } = await supabase
      .from("payments")
      .select("*, students(name, student_id, class)")
      .eq("school_id", schoolData.id)
      .order("date", { ascending: false });

    const studentRows: StudentRow[] = (studentsData || []).map((s: any) => {
      const fees = (feeData || []).filter((f: any) => f.student_id === s.id);
      return {
        ...s,
        totalFees: fees.reduce((a: number, f: any) => a + Number(f.amount), 0),
        totalPaid: fees.reduce((a: number, f: any) => a + Number(f.paid), 0),
      };
    });

    // Sort alphabetically by surname (name format: Surname FirstName MiddleName)
    studentRows.sort((a, b) => a.name.localeCompare(b.name));

    setStudents(studentRows);
    setPayments(paymentsData || []);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [slug]);

  // Student ID generation removed - now using initials-based IDs

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSurname.trim() || !newFirstName.trim() || !newStudentClass) {
      toast.error("Surname, First Name, and Class are required");
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
    });

    if (error) {
      toast.error(error.message);
    } else {
      toast.success(`Student added! ID: ${studentId}, Default Password: password`);
      setAddStudentOpen(false);
      setNewSurname("");
      setNewFirstName("");
      setNewMiddleName("");
      setNewStudentClass("");
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
    if (!feeStudentId) {
      toast.error("Please select a student");
      return;
    }

    const validFees = feeEntries.filter((f) => f.name.trim() && Number(f.amount) > 0);
    if (validFees.length === 0) {
      toast.error("Add at least one fee with an amount");
      return;
    }

    setAddingFee(true);

    const inserts = validFees.map((f) => ({
      school_id: school.id,
      student_id: feeStudentId,
      name: f.name.trim(),
      amount: Number(f.amount),
    }));

    const { error } = await supabase.from("fee_items").insert(inserts);

    if (error) {
      toast.error(error.message);
    } else {
      toast.success(`${validFees.length} fee(s) added!`);
      setAddFeeOpen(false);
      setFeeStudentId("");
      setFeeEntries(DEFAULT_FEE_TEMPLATES.map((name) => ({ name, amount: "" })));
      loadData();
    }
    setAddingFee(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate(`/school/${slug}`);
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

  const filteredStudents = students.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.student_id.toLowerCase().includes(search.toLowerCase())
  );

  const filteredPayments = payments.filter((p) => {
    const studentName = (p.students as any)?.name || "";
    return studentName.toLowerCase().includes(search.toLowerCase()) ||
      p.reference.toLowerCase().includes(search.toLowerCase());
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
            <Card>
              <CardContent className="pt-6 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Student ID</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead>Default PIN</TableHead>
                      <TableHead className="text-right">Total Fees</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredStudents.map((s) => {
                      const bal = s.totalFees - s.totalPaid;
                      const status = bal === 0 && s.totalFees > 0 ? "paid" : s.totalPaid > 0 ? "partial" : "unpaid";
                      return (
                        <TableRow key={s.id}>
                          <TableCell className="font-mono text-xs">{s.student_id}</TableCell>
                          <TableCell className="font-medium">{s.name}</TableCell>
                          <TableCell><Badge variant="outline">{s.class}</Badge></TableCell>
                          <TableCell>
                            {s.must_change_pin && s.default_pin ? (
                              <code className="bg-muted px-2 py-0.5 rounded text-xs font-bold">{s.default_pin}</code>
                            ) : (
                              <span className="text-xs text-muted-foreground">Changed</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">{formatNaira(s.totalFees)}</TableCell>
                          <TableCell className="text-right">{formatNaira(s.totalPaid)}</TableCell>
                          <TableCell className="text-right font-medium">{formatNaira(bal)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={status === "paid" ? "bg-primary/15 text-primary" : status === "partial" ? "bg-accent/15 text-accent-foreground" : "bg-destructive/10 text-destructive"}>
                              {status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="sm" title="Reset PIN" onClick={() => handleResetPin(s.id, s.name)}>
                              <KeyRound className="w-4 h-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredStudents.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                          No students found. Add your first student above.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="payments">
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Student</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPayments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>{new Date(p.date).toLocaleDateString("en-NG")}</TableCell>
                        <TableCell className="font-medium">{(p.students as any)?.name || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{p.reference}</TableCell>
                        <TableCell className="text-xs">{p.items?.join(", ")}</TableCell>
                        <TableCell className="text-right font-medium">{formatNaira(Number(p.amount))}</TableCell>
                      </TableRow>
                    ))}
                    {filteredPayments.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground py-8">No payments yet.</TableCell>
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
              <Label>Student</Label>
              <Select value={feeStudentId} onValueChange={setFeeStudentId}>
                <SelectTrigger><SelectValue placeholder="Select a student" /></SelectTrigger>
                <SelectContent>
                  {students.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name} ({s.student_id})</SelectItem>
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
