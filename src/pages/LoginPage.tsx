import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/authContext";
import { supabase } from "@/lib/supabaseClient";
import { GraduationCap, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const LoginPage = () => {
  const [studentId, setStudentId] = useState("");
  const [pin, setPin] = useState("");
  const [adminUser, setAdminUser] = useState("");
  const [adminPass, setAdminPass] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { login, loginAdmin } = useAuth();
  const navigate = useNavigate();

  const handleStudentLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!studentId.trim() || !pin.trim()) {
      toast.error("Please enter both School ID and PIN");
      return;
    }

    setIsLoading(true);
    try {
      // Query students table directly using Supabase client
      const { data: students, error } = await supabase
        .from("students")
        .select("*")
        .eq("id", studentId)
        .maybeSingle();

      if (error) {
        console.error("Database error:", error);
        toast.error("An error occurred. Please try again.");
        setIsLoading(false);
        return;
      }

      if (!students) {
        toast.error("Invalid School ID or PIN");
        setIsLoading(false);
        return;
      }

      // Verify PIN matches exactly
      if (students.pin !== pin) {
        toast.error("Invalid School ID or PIN");
        setIsLoading(false);
        return;
      }

      // PIN matched - sign the student in
      login(students);
      toast.success("Login successful!");
      navigate("/student");
    } catch (error) {
      console.error("Login error:", error);
      toast.error("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const handleAdminLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (adminUser === "admin" && adminPass === "admin123") {
      loginAdmin();
      navigate("/admin");
    } else {
      toast.error("Invalid admin credentials");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary/5 p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <GraduationCap className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">EduLedger<span className="text-primary font-bold">NG</span></h1>
          <p className="text-muted-foreground mt-1">School Fee Management System</p>
        </div>

        <Card className="shadow-lg border-primary/10">
          <Tabs defaultValue="student">
            <CardHeader className="pb-4">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="student" className="gap-2">
                  <GraduationCap className="w-4 h-4" />Student
                </TabsTrigger>
                <TabsTrigger value="admin" className="gap-2">
                  <ShieldCheck className="w-4 h-4" />Admin
                </TabsTrigger>
              </TabsList>
            </CardHeader>

            <CardContent>
              <TabsContent value="student" className="mt-0">
                <form onSubmit={handleStudentLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="studentId">School ID</Label>
                    <Input 
                      id="studentId" 
                      placeholder="e.g. EDU/2024/001" 
                      value={studentId} 
                      onChange={(e) => setStudentId(e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pin">PIN</Label>
                    <Input 
                      id="pin" 
                      type="password" 
                      placeholder="Enter your PIN" 
                      value={pin} 
                      onChange={(e) => setPin(e.target.value)} 
                      maxLength={10}
                      disabled={isLoading}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? "Signing in..." : "Sign In"}
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="admin" className="mt-0">
                <form onSubmit={handleAdminLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="adminUser">Username</Label>
                    <Input id="adminUser" placeholder="Admin username" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="adminPass">Password</Label>
                    <Input id="adminPass" type="password" placeholder="Admin password" value={adminPass} onChange={(e) => setAdminPass(e.target.value)} />
                  </div>
                  <Button type="submit" className="w-full">Sign In</Button>
                  <p className="text-xs text-muted-foreground text-center">Demo: admin / admin123</p>
                </form>
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>
      </div>
    </div>
  );
};

export default LoginPage;
