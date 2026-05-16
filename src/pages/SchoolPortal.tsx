import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GraduationCap, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSchool } from "@/lib/schoolContext";

const SchoolPortal = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { loginStudent, setSchool } = useSchool();

  const [schoolName, setSchoolName] = useState<string | null>(null);
  const [schoolLoading, setSchoolLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [studentId, setStudentId] = useState("");
  const [pin, setPin] = useState("");
  const [studentLoading, setStudentLoading] = useState(false);

  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);

  useEffect(() => {
    const loadSchool = async () => {
      if (!slug) return;
      const { data, error } = await supabase
        .from("schools")
        .select("id, name")
        .eq("slug", slug)
        .maybeSingle();

      if (error || !data) {
        setNotFound(true);
      } else {
        setSchoolName(data.name);
        setSchool(data);
      }
      setSchoolLoading(false);
    };
    loadSchool();
  }, [slug]);

  const handleStudentLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setStudentLoading(true);

    try {
      // Query students table directly with uppercase student ID
      const { data: student, error: dbError } = await supabase
        .from("students")
        .select("*")
        .eq("student_id", studentId.trim().toUpperCase())
        .maybeSingle();

      if (dbError) {
        console.error("Database error:", dbError);
        toast.error("An error occurred. Please try again.");
        setStudentLoading(false);
        return;
      }

      // Verify PIN matches exactly (case-sensitive) using pin column
      if (!student || student.pin.trim() !== pin.trim()) {
        toast.error("Invalid Student ID or PIN");
        setStudentLoading(false);
        return;
      }

      // Check if student is logging in for the first time
      if (student.is_first_login === true) {
        toast.info("First-time login detected. Redirecting to set your new password...");
        navigate(`/school/${slug}/reset-password`, { state: { studentId: student.student_id } });
        setStudentLoading(false);
        return;
      }

      // Clear stale local storage auth states to prevent loops
      localStorage.removeItem("sb-auth-token");

      // PIN matched - sign the student in with database row properties
      await loginStudent(
        {
          id: student.id,
          student_id: student.student_id,
          name: student.name || student.full_name || student.student_id,
          role: "student",
        },
        [],
        []
      );
      
      toast.success("Login successful! Welcome back.");
      navigate(`/school/${slug}/student`);
    } catch (error) {
      console.error("Login error:", error);
      toast.error("An unexpected error occurred");
    } finally {
      setStudentLoading(false);
    }
  };

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: adminEmail,
      password: adminPassword,
    });

    if (error) {
      toast.error(error.message);
      setAdminLoading(false);
      return;
    }

    // Verify this user is owner or admin of THIS school
    const { data: school } = await supabase
      .from("schools")
      .select("id, name, owner_id")
      .eq("slug", slug!)
      .maybeSingle();

    if (!school) {
      toast.error("School not found");
      await supabase.auth.signOut();
      setAdminLoading(false);
      return;
    }

    const isOwner = school.owner_id === data.user.id;
    if (!isOwner) {
      const { data: adminEntry } = await supabase
        .from("school_admins")
        .select("id")
        .eq("school_id", school.id)
        .eq("user_id", data.user.id)
        .maybeSingle();

      if (!adminEntry) {
        toast.error("You are not an admin of this school");
        await supabase.auth.signOut();
        setAdminLoading(false);
        return;
      }
    }

    navigate(`/school/${slug}/admin`);
    setAdminLoading(false);
  };

  if (schoolLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary/5">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary/5 p-4">
        <Card className="max-w-md w-full text-center">
          <CardContent className="pt-8 pb-8 space-y-4">
            <h2 className="text-xl font-bold">School Not Found</h2>
            <p className="text-muted-foreground">
              The school portal "{slug}" does not exist.
            </p>
            <Button onClick={() => navigate("/")}>Go Home</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary/5 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <GraduationCap className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">{schoolName}</h1>
          <p className="text-muted-foreground mt-1">Powered by EduLedger<span className="text-primary font-bold">NG</span></p>
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
                    <Label>Student ID</Label>
                    <Input
                      placeholder="e.g. EDU/2024/001"
                      value={studentId}
                      onChange={(e) => setStudentId(e.target.value)}
                      required
                      maxLength={30}
                      disabled={studentLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>PIN</Label>
                    <Input
                      type="password"
                      placeholder="Enter your PIN"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      required
                      maxLength={10}
                      disabled={studentLoading}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={studentLoading}>
                    {studentLoading ? "Signing in..." : "Sign In"}
                  </Button>
                </form>
              </TabsContent>
              <TabsContent value="admin" className="mt-0">
                <form onSubmit={handleAdminLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label>Email</Label>
                    <Input
                      type="email"
                      placeholder="admin@school.com"
                      value={adminEmail}
                      onChange={(e) => setAdminEmail(e.target.value)}
                      required
                      disabled={adminLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Password</Label>
                    <Input
                      type="password"
                      placeholder="Password"
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      required
                      disabled={adminLoading}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={adminLoading}>
                    {adminLoading ? "Signing in..." : "Sign In"}
                  </Button>
                </form>
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>
      </div>
    </div>
  );
};

export default SchoolPortal;
