import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GraduationCap, ShieldCheck, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionsError } from "@/lib/utils";
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

  const [showPin, setShowPin] = useState(false);
  const [showAdminPassword, setShowAdminPassword] = useState(false);

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
      const cleanStudentId = studentId.trim().toUpperCase();
      const cleanPin = pin.trim();

      // PIN verification happens server-side (verify_student_pin RPC) so the
      // pin column is never read from the browser.
      const { data, error } = await supabase.functions.invoke("student-auth", {
        body: { school_slug: slug, student_id: cleanStudentId, pin: cleanPin },
      });

      if (error || data?.error) {
        toast.error(data?.error || (await readFunctionsError(error, "Invalid Student ID or PIN")));
        return;
      }

      const student = data.student;
      if (!student) {
        toast.error("Invalid Student ID or PIN");
        return;
      }

      // First-time login: force a password reset before entering the dashboard.
      // Pass the current PIN so the reset page can prove it server-side.
      if (student.must_change_pin) {
        toast.info("First-time login detected. Redirecting to set your new password...");
        navigate(`/school/${slug}/reset-password`, {
          state: { studentId: student.student_id, currentPin: cleanPin },
        });
        return;
      }

      loginStudent(
        {
          id: student.id,
          student_id: student.student_id,
          name: student.name || student.student_id,
          class: student.class || "Unassigned",
          term: student.term,
          session: student.session,
          school_id: student.school_id,
        },
        data.feeItems || [],
        data.payments || [],
        { student_id: cleanStudentId, pin: cleanPin }
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

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: adminEmail,
        password: adminPassword,
      });

      if (error) {
        toast.error(error.message);
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
          return;
        }
      }

      navigate(`/school/${slug}/admin`);
    } catch (err) {
      console.error("Admin login error:", err);
      toast.error("Something went wrong signing in. Please try again.");
    } finally {
      setAdminLoading(false);
    }
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
          <img src="/logo.jpeg" alt="" className="mx-auto mb-4 block w-16 h-16 rounded-2xl object-contain" />
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
                      maxLength={50}
                      disabled={studentLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>PIN</Label>
                    <div className="relative">
                      <Input
                        type={showPin ? "text" : "password"}
                        placeholder="Enter your PIN"
                        value={pin}
                        onChange={(e) => setPin(e.target.value)}
                        required
                        maxLength={50}
                        disabled={studentLoading}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                        onClick={() => setShowPin(!showPin)}
                        disabled={studentLoading}
                        tabIndex={-1}
                      >
                        {showPin ? (
                          <EyeOff className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <Eye className="w-4 h-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
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
                    <div className="relative">
                      <Input
                        type={showAdminPassword ? "text" : "password"}
                        placeholder="Password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        required
                        disabled={adminLoading}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                        onClick={() => setShowAdminPassword(!showAdminPassword)}
                        disabled={adminLoading}
                        tabIndex={-1}
                      >
                        {showAdminPassword ? (
                          <EyeOff className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <Eye className="w-4 h-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
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
