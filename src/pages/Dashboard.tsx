// src/pages/Dashboard.tsx
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Plus, LogOut } from "lucide-react";
import { toast } from "sonner";
import { GraduationCap } from "lucide-react";

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

  useEffect(() => {
    const fetchUserAndSchools = async () => {
      // 1. Get current user
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        navigate("/owner-login");
        return;
      }

      try {
        // 2. Fetch school_admins entries for this user
        const { data: adminEntries, error: adminError } = await supabase
          .from("school_admins")
          .select("school_id, role")
          .eq("user_id", user.id);

        if (adminError) {
          toast.error("Failed to load your schools: " + adminError.message);
          setLoading(false);
          return;
        }

        if (!adminEntries || adminEntries.length === 0) {
          setSchools([]);
          setLoading(false);
          return;
        }

        const schoolIds = adminEntries.map((entry) => entry.school_id);

        // 3. Fetch school details for those IDs
        const { data: schoolsData, error: schoolsError } = await supabase
          .from("schools")
          .select("id, name, slug")
          .in("id", schoolIds);

        if (schoolsError) {
          toast.error("Failed to load school details: " + schoolsError.message);
          setLoading(false);
          return;
        }

        // 4. Combine role from adminEntries
        const mapped = schoolsData.map((school) => ({
          id: school.id,
          name: school.name,
          slug: school.slug,
          role: adminEntries.find((entry) => entry.school_id === school.id)?.role || "admin",
        }));

        setSchools(mapped);
      } catch (err) {
        console.error(err);
        toast.error("An unexpected error occurred");
      } finally {
        setLoading(false);
      }
    };

    fetchUserAndSchools();
  }, [navigate]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/owner-login");
  };

  const handleCreateSchool = () => {
    navigate("/register-school");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground">Loading your schools…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">EduLedger<span className="text-primary font-bold">NG</span></span>
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </header>

      <main className="container mx-auto py-10 px-4 max-w-4xl">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Your Schools</h1>
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
                You haven’t been added to any school yet, or you haven’t registered one.
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