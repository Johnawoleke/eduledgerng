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
  GraduationCap, 
  Bell, 
  Check, 
  X,
  Mail,
  Clock,
  Loader2,
  User,
  Sparkles
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

interface School {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface Request {
  id: string;
  school: {
    id: string;
    name: string;
    slug: string;
  };
  role: string;
  status: string;
  expires_at: string;
  requested_by_email?: string;
}

const Dashboard = () => {
  const navigate = useNavigate();
  const [schools, setSchools] = useState<School[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvitations, setShowInvitations] = useState(false);
  const [processingRequest, setProcessingRequest] = useState<string | null>(null);
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

      try {
        // 2. Fetch schools
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

        // 3. Fetch pending requests directly (no profiles join)
        console.log("🔍 Fetching requests for user:", user.id);
        const { data: requestsData, error: requestsError } = await supabase
          .from("school_requests")
          .select("*")
          .eq("user_id", user.id)
          .eq("status", "pending")
          .gte("expires_at", new Date().toISOString());

        if (requestsError) {
          console.error("❌ Error fetching requests:", requestsError);
        } else {
          console.log("📧 Requests found:", requestsData?.length || 0);
          
          // Get school details for each request
          const mappedRequests: Request[] = [];
          for (const req of (requestsData || [])) {
            const { data: schoolData } = await supabase
              .from("schools")
              .select("id, name, slug")
              .eq("id", req.school_id)
              .single();
            
            if (schoolData) {
              mappedRequests.push({
                id: req.id,
                school: schoolData,
                role: req.role,
                status: req.status,
                expires_at: req.expires_at,
                requested_by_email: "School Administrator", // We'll get this from the edge function if needed
              });
            }
          }
          
          setRequests(mappedRequests);
          
          // Show invitations modal if there are pending requests
          if (mappedRequests.length > 0) {
            console.log("🎯 Showing invitations modal");
            setShowInvitations(true);
          }
        }
      } catch (err) {
        console.error("💥 Unexpected error:", err);
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

  const handleRequestAction = async (requestId: string, action: "accept" | "decline") => {
    setProcessingRequest(requestId);
    try {
      const { data, error } = await supabase.functions.invoke("handle-school-request", {
        body: { requestId, action },
      });

      if (error) {
        let errorMsg = error.message || "Failed to process request";
        try {
          const response = (error as any).context;
          if (response && response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let result = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              result += decoder.decode(value, { stream: true });
            }
            const parsed = JSON.parse(result);
            if (parsed.error) errorMsg = parsed.error;
          }
        } catch (parseErr) { /* fallback */ }
        toast.error(errorMsg);
        setProcessingRequest(null);
        return;
      }

      if (action === "accept") {
        toast.success("🎉 Accepted! You now have access to this school.");
        window.location.reload();
      } else {
        toast.success("Request declined.");
        setRequests(requests.filter((r) => r.id !== requestId));
        if (requests.filter((r) => r.id !== requestId).length === 0) {
          setShowInvitations(false);
        }
      }
    } catch (err) {
      console.error("Error processing request:", err);
      toast.error("An unexpected error occurred");
    } finally {
      setProcessingRequest(null);
    }
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
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">EduLedger<span className="text-primary font-bold">NG</span></span>
            {requests.length > 0 && (
              <Badge 
                variant="destructive" 
                className="ml-2 animate-pulse flex items-center gap-1"
              >
                <Bell className="w-3 h-3" />
                {requests.length}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {requests.length > 0 && (
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setShowInvitations(true)}
                className="gap-2 relative"
              >
                <Bell className="w-4 h-4" />
                <span className="hidden sm:inline">Invitations</span>
                <Badge variant="destructive" className="absolute -top-2 -right-2 h-5 w-5 flex items-center justify-center p-0 text-xs">
                  {requests.length}
                </Badge>
              </Button>
            )}
            <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
              <User className="w-4 h-4" />
              <span className="font-medium">{userName}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
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
                You haven't been added to any school yet, or you haven't registered one.
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

        {/* Invitations Section */}
        {requests.length > 0 && (
          <div className="mt-8">
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary" />
              Pending Invitations
              <Badge variant="destructive" className="ml-2">
                {requests.length}
              </Badge>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {requests.map((request) => (
                <Card key={request.id} className="border-primary/20 bg-primary/5">
                  <CardContent className="pt-6">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                      <div>
                        <p className="font-semibold text-lg">{request.school.name}</p>
                        <p className="text-sm text-muted-foreground">
                          Role: <span className="capitalize font-medium">{request.role}</span>
                        </p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                          <Clock className="w-3 h-3" />
                          <span>Expires: {new Date(request.expires_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="flex gap-2 w-full sm:w-auto">
                        <Button
                          size="sm"
                          className="gap-1 flex-1 sm:flex-none"
                          onClick={() => handleRequestAction(request.id, "accept")}
                          disabled={processingRequest === request.id}
                        >
                          {processingRequest === request.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Check className="w-4 h-4" />
                          )}
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="gap-1 flex-1 sm:flex-none"
                          onClick={() => handleRequestAction(request.id, "decline")}
                          disabled={processingRequest === request.id}
                        >
                          <X className="w-4 h-4" />
                          Decline
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Invitations Modal */}
      <Dialog open={showInvitations} onOpenChange={setShowInvitations}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <Mail className="w-5 h-5 text-primary" />
              School Invitations
            </DialogTitle>
            <DialogDescription>
              You have been invited to join the following schools. Accept or decline each invitation.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
            {requests.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No pending invitations.</p>
              </div>
            ) : (
              requests.map((request) => (
                <Card key={request.id} className="border-primary/20 bg-primary/5">
                  <CardContent className="pt-4 pb-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <p className="font-semibold text-lg">{request.school.name}</p>
                        <p className="text-sm text-muted-foreground">
                          Role: <span className="capitalize font-medium">{request.role}</span>
                        </p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          <span>Expires: {new Date(request.expires_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="flex gap-2 w-full sm:w-auto">
                        <Button
                          size="sm"
                          className="gap-1 flex-1 sm:flex-none"
                          onClick={() => handleRequestAction(request.id, "accept")}
                          disabled={processingRequest === request.id}
                        >
                          {processingRequest === request.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Check className="w-4 h-4" />
                          )}
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="gap-1 flex-1 sm:flex-none"
                          onClick={() => handleRequestAction(request.id, "decline")}
                          disabled={processingRequest === request.id}
                        >
                          <X className="w-4 h-4" />
                          Decline
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          <DialogFooter className="flex justify-between items-center">
            <p className="text-xs text-muted-foreground">
              {requests.length > 0 && `You have ${requests.length} pending invitation${requests.length > 1 ? 's' : ''}`}
            </p>
            <Button variant="outline" onClick={() => setShowInvitations(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Dashboard;