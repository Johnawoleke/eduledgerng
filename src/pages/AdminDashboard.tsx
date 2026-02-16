import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/authContext";
import { students, feeStructure, payments, formatNaira, classes } from "@/lib/mockData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GraduationCap, LogOut, Users, Wallet, TrendingUp, Search, Receipt } from "lucide-react";

const AdminDashboard = () => {
  const { isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState("all");

  if (!isAdmin) {
    navigate("/");
    return null;
  }

  // Compute stats
  const totalStudents = students.length;
  const totalCollected = payments.reduce((s, p) => s + p.amount, 0);
  const totalFees = students.reduce((s, st) => {
    const fees = feeStructure[st.id] || [];
    return s + fees.reduce((a, f) => a + f.amount, 0);
  }, 0);
  const outstanding = totalFees - totalCollected;

  const filteredPayments = payments.filter((p) => {
    const matchSearch = p.studentName.toLowerCase().includes(search.toLowerCase()) || p.reference.toLowerCase().includes(search.toLowerCase());
    const matchClass = classFilter === "all" || p.class === classFilter;
    return matchSearch && matchClass;
  });

  const filteredStudents = students.filter((s) => {
    const matchSearch = s.name.toLowerCase().includes(search.toLowerCase()) || s.id.toLowerCase().includes(search.toLowerCase());
    const matchClass = classFilter === "all" || s.class === classFilter;
    return matchSearch && matchClass;
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">EduLedger<span className="text-primary font-bold">NG</span></span>
            <Badge variant="outline" className="ml-2 text-xs">Admin</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={() => { logout(); navigate("/"); }}>
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
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

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search students or references..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={classFilter} onValueChange={setClassFilter}>
            <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="All Classes" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Classes</SelectItem>
              {classes.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <Tabs defaultValue="payments">
          <TabsList>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="students">Students</TabsTrigger>
          </TabsList>

          <TabsContent value="payments">
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Student</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPayments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>{new Date(p.date).toLocaleDateString("en-NG")}</TableCell>
                        <TableCell className="font-medium">{p.studentName}</TableCell>
                        <TableCell><Badge variant="outline">{p.class}</Badge></TableCell>
                        <TableCell className="font-mono text-xs">{p.reference}</TableCell>
                        <TableCell className="text-right font-medium">{formatNaira(p.amount)}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" onClick={() => navigate(`/receipt/${p.id}`)}>
                            <Receipt className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="students">
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>School ID</TableHead>
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
                      const fees = feeStructure[s.id] || [];
                      const total = fees.reduce((a, f) => a + f.amount, 0);
                      const paid = fees.reduce((a, f) => a + f.paid, 0);
                      const bal = total - paid;
                      const status = bal === 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
                      return (
                        <TableRow key={s.id}>
                          <TableCell className="font-mono text-xs">{s.id}</TableCell>
                          <TableCell className="font-medium">{s.name}</TableCell>
                          <TableCell><Badge variant="outline">{s.class}</Badge></TableCell>
                          <TableCell className="text-right">{formatNaira(total)}</TableCell>
                          <TableCell className="text-right">{formatNaira(paid)}</TableCell>
                          <TableCell className="text-right font-medium">{formatNaira(bal)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={status === "paid" ? "bg-primary/15 text-primary" : status === "partial" ? "bg-accent/15 text-accent-foreground" : "bg-destructive/10 text-destructive"}>
                              {status}
                            </Badge>
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

export default AdminDashboard;
