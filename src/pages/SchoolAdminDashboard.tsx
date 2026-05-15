import React, { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GraduationCap, LogOut, Users, Wallet, TrendingUp, Search, UserPlus, Plus, KeyRound, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);

const NIGERIAN_CLASSES = ["JSS1", "JSS2", "JSS3", "SSS1", "SSS2", "SSS3"];

const SchoolAdminDashboard = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [school, setSchool] = useState<any>(null);
  const [students, setStudents] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [studentsClassFilter, setStudentsClassFilter] = useState("JSS1");
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { navigate(`/school/${slug}`); return; }

    const { data: schoolData } = await supabase
      .from("schools")
      .select("*")
      .eq("slug", slug!)
      .maybeSingle();

    if (!schoolData) return;
    setSchool(schoolData);

    // Only fetch ACTIVE students
    const { data: studentsData } = await supabase
      .from("students")
      .select("*")
      .eq("school_id", schoolData.id)
      .eq("status", "active");

    setStudents(studentsData || []);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [slug]);

  const handleRemoveStudent = async (studentId: string) => {
    if (window.confirm("Are you sure you want to remove this student?")) {
      const { error } = await supabase
        .from("students")
        .update({ status: "inactive" } as any)
        .eq("id", studentId);

      if (error) {
        toast.error("Error removing student");
      } else {
        toast.success("Student moved to inactive");
        loadData(); // Refresh list
      }
    }
  };

  const filteredStudents = students.filter((s) => {
    const matchClass = s.class === studentsClassFilter;
    const matchSearch = s.name.toLowerCase().includes(search.toLowerCase()) || s.student_id.toLowerCase().includes(search.toLowerCase());
    return matchClass && matchSearch;
  });

  if (loading) return <div className="p-10 text-center">Loading...</div>;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card px-4 py-4">
        <div className="container mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2">
            <GraduationCap className="text-primary" />
            <span className="font-bold">{school?.name}</span>
          </div>
          <Button variant="ghost" onClick={() => supabase.auth.signOut()}><LogOut className="w-4 h-4" /></Button>
        </div>
      </header>

      <main className="container mx-auto p-4 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card><CardContent className="pt-6 flex gap-3"><Users /> <div><p className="text-sm">Students</p><p className="text-xl font-bold">{students.length}</p></div></CardContent></Card>
          <Card><CardContent className="pt-6 flex gap-3"><TrendingUp /> <div><p className="text-sm">Collected</p><p className="text-xl font-bold">₦0</p></div></CardContent></Card>
          <Card><CardContent className="pt-6 flex gap-3"><Wallet /> <div><p className="text-sm">Debt</p><p className="text-xl font-bold">₦0</p></div></CardContent></Card>
        </div>

        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search name or ID..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button variant="outline" className="gap-2"><UserPlus className="w-4 h-4" /> Add Student</Button>
          <Button variant="outline" className="gap-2"><Plus className="w-4 h-4" /> Add Fee</Button>
        </div>

        <div className="flex gap-2 overflow-x-auto">
          {NIGERIAN_CLASSES.map(c => (
            <Button key={c} variant={studentsClassFilter === c ? "default" : "outline"} onClick={() => setStudentsClassFilter(c)}>{c}</Button>
          ))}
        </div>

        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Payment Progress</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredStudents.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.student_id}</TableCell>
                  <TableCell>
                    <div className="w-full h-2 bg-gray-100 rounded-full">
                      <div className="h-full bg-primary rounded-full" style={{ width: '0%' }} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right space-x-2">
                    <Button variant="ghost" size="sm"><KeyRound className="w-4 h-4"/></Button>
                    <Button variant="ghost" size="sm" className="text-red-500" onClick={() => handleRemoveStudent(s.id)}>
                      <Trash2 className="w-4 h-4"/>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </main>
    </div>
  );
};

export default SchoolAdminDashboard;
