// src/pages/Dashboard.tsx
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Building2,
  Plus,
  LogOut,
  User,
  Sparkles,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";

interface School {
  id: string;
  name: string;
  slug: string;
  role: string;
}

const Dashboard = () => {
  const navigate = useNavigate();
  const [schools, setSchools] = useState<School[]>([]);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState<string>("");

  useEffect(() => {
    const fetchData = async () => {
      // 1. Get current user
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        navigate("/login");
        return;
      }

      // Get user name from metadata or email
      const name = user.user_metadata?.full_name || user.email?.split("@")[0] || "User";
      setUserName(name);

      // Force a freshly-created bursar to replace their temporary password
      // before they can use the app.
      const { data: profile } = await supabase
        .from("profiles")
        .select("must_change_password")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.must_change_password) {
        navigate("/change-password");
        return;
      }

      try {
        // 2. Fetch the schools this user owns or works at
        const { data: adminEntries, error: adminError } = await supabase
          .from("school_admins")
          .select("school_id, role")
          .eq("user_id", user.id);

        if (adminError) {
          toast.error("Failed to load your schools: " + adminError.message);
          setLoading(false);
          return;
        }

        let mappedSchools: School[] = [];
        if (adminEntries && adminEntries.length > 0) {
          const schoolIds = adminEntries.map((entry) => entry.school_id);
          const { data: schoolsData, error: schoolsError } = await supabase
            .from("schools")
            .select("id, name, slug")
            .in("id", schoolIds);

          if (schoolsError) {
            toast.error("Failed to load school details: " + schoolsError.message);
          } else {
            mappedSchools = schoolsData.map((school) => ({
              id: school.id,
              name: school.name,
              slug: school.slug,
              role: adminEntries.find((entry) => entry.school_id === school.id)?.role || "admin",
            }));
          }
        }
        setSchools(mappedSchools);
      } catch (err) {
        console.error("Unexpected error:", err);
        toast.error("An unexpected error occurred");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [navigate]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/login");
  };

  const handleCreateSchool = () => {
    navigate("/register-school");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-2">
            <img src="/logo.jpeg" alt="" className="w-8 h-8 rounded-lg object-contain" />
            <span className="font-bold text-lg">EduLedger<span className="text-primary font-bold">NG</span></span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
              <User className="w-4 h-4" />
              <span className="font-medium">{userName}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate("/change-password")} title="Change password">
              <KeyRound className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout} title="Log out">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto py-10 px-4 max-w-4xl">
        {/* Personalized Welcome */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              Welcome back, {userName}!
              <Sparkles className="w-6 h-6 text-primary" />
            </h1>
            <p className="text-muted-foreground mt-1">
              {schools.length === 0
                ? "Get started by registering your first school."
                : `You have ${schools.length} school${schools.length > 1 ? 's' : ''} to manage.`}
            </p>
          </div>
          <Button onClick={handleCreateSchool} className="gap-2">
            <Plus className="w-4 h-4" /> New School
          </Button>
        </div>

        {schools.length === 0 ? (
          <Card className="border-dashed border-2 border-muted-foreground/30 bg-muted/20">
            <CardContent className="flex flex-col items-center py-16 space-y-4">
              <Building2 className="w-16 h-16 text-muted-foreground/50" />
              <h2 className="text-2xl font-semibold">Welcome to EduLedgerNG!</h2>
              <p className="text-muted-foreground max-w-sm text-center">
                You haven't registered a school yet.
              </p>
              <Button onClick={handleCreateSchool} className="gap-2">
                <Plus className="w-4 h-4" /> Register Your School
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {schools.map((school) => (
              <Card key={school.id} className="hover:shadow-md transition-shadow">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>{school.name}</span>
                    <span className="text-sm font-normal text-muted-foreground capitalize">
                      {school.role}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => navigate(`/school/${school.slug}/admin`)}
                  >
                    Go to Admin
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default Dashboard;
