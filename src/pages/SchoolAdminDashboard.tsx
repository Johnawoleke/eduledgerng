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
import { GraduationCap, LogOut, Users, Wallet, TrendingUp, Search, Plus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);

interface StudentRow {
  id: string;
  student_id: string;
  name: string;
  class: string;
  term: string;
  session: string;
  totalFees: number;
  totalPaid: number;
}

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
  const [newStudentId, setNewStudentId] = useState("");
  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentClass, setNewStudentClass] = useState("");
  const [newStudentPin, setNewStudentPin] = useState("");
  const [addingStudent, setAddingStudent] = useState(false);

  // Add fee dialog
  const [addFeeOpen, setAddFeeOpen] = useState(false);
  const [feeStudentId, setFeeStudentId] = useState("");
  const [feeName, setFeeName] = useState("");
  const [feeAmount, setFeeAmount] = useState("");
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

    // Load students with fee totals
    const { data: studentsData } = await supabase
      .from("students")
      .select("id, student_id, name, class, term, session")
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

    const studentRows: StudentRow[] = (studentsData || []).map((s) => {
      const fees = (feeData || []).filter((f) => f.student_id === s.id);
      return {
        ...s,
        totalFees: fees.reduce((a, f) => a + Number(f.amount), 0),
        totalPaid: fees.reduce((a, f) => a + Number(f.paid), 0),
      };
    });

    setStudents(studentRows);
    setPayments(paymentsData || []);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [slug]);

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStudentId || !newStudentName || !newStudentClass || !newStudentPin) {
      toast.error("All fields are required");
      return;
    }
    setAddingStudent(true);

    const { error } = await supabase.from("students").insert({
      school_id: school.id,
      student_id: newStudentId,
      name: newStudentName,
      class: newStudentClass,
      pin: newStudentPin,
    });

    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Student added!");
      setAddStudentOpen(false);
      setNewStudentId("");
      setNewStudentName("");
      setNewStudentClass("");
      setNewStudentPin("");
      loadData();
    }
    setAddingStudent(false);
  };

  const handleAddFee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feeStudentId || !feeName || !feeAmount) {
      toast.error("All fields are required");
      return;
    }
    setAddingFee(true);

    const { error } = await supabase.from("fee_items").insert({
      school_id: school.id,
      student_id: feeStudentId,
      name: feeName,
      amount: Number(feeAmount),
    });

    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Fee added!");
      setAddFeeOpen(false);
      setFeeStudentId("");
      setFeeName("");
      setFeeAmount("");
      loadData();
    }
    setAddingFee(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate(`/school/${slug}`);
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
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Student ID</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead className="text-right">Total Fees</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Status</TableHead>
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
                          <TableCell className="text-right">{formatNaira(s.totalFees)}</TableCell>
                          <TableCell className="text-right">{formatNaira(s.totalPaid)}</TableCell>
                          <TableCell className="text-right font-medium">{formatNaira(bal)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={status === "paid" ? "bg-primary/15 text-primary" : status === "partial" ? "bg-accent/15 text-accent-foreground" : "bg-destructive/10 text-destructive"}>
                              {status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredStudents.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
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
            <DialogDescription>Create a new student account for your school.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddStudent} className="space-y-4">
            <div className="space-y-2">
              <Label>Student ID</Label>
              <Input placeholder="e.g. EDU/2024/001" value={newStudentId} onChange={(e) => setNewStudentId(e.target.value)} maxLength={30} required />
            </div>
            <div className="space-y-2">
              <Label>Full Name</Label>
              <Input placeholder="Student name" value={newStudentName} onChange={(e) => setNewStudentName(e.target.value)} maxLength={100} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Class</Label>
                <Input placeholder="e.g. SSS2" value={newStudentClass} onChange={(e) => setNewStudentClass(e.target.value)} maxLength={20} required />
              </div>
              <div className="space-y-2">
                <Label>PIN</Label>
                <Input type="password" placeholder="Login PIN" value={newStudentPin} onChange={(e) => setNewStudentPin(e.target.value)} maxLength={10} required />
              </div>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Fee</DialogTitle>
            <DialogDescription>Add a fee item for a student.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddFee} className="space-y-4">
            <div className="space-y-2">
              <Label>Student</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={feeStudentId}
                onChange={(e) => setFeeStudentId(e.target.value)}
                required
              >
                <option value="">Select a student</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.student_id})</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Fee Name</Label>
              <Input placeholder="e.g. Tuition Fee" value={feeName} onChange={(e) => setFeeName(e.target.value)} maxLength={100} required />
            </div>
            <div className="space-y-2">
              <Label>Amount (₦)</Label>
              <Input type="number" placeholder="Amount" value={feeAmount} onChange={(e) => setFeeAmount(e.target.value)} min={1} required />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={addingFee}>
                {addingFee ? "Adding..." : "Add Fee"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SchoolAdminDashboard;
