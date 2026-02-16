import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { GraduationCap, ArrowRight, CheckCircle2, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const RegisterSchool = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<"details" | "account" | "done">("details");
  const [schoolName, setSchoolName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [schoolEmail, setSchoolEmail] = useState("");
  const [schoolCode, setSchoolCode] = useState("");
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [createdSlug, setCreatedSlug] = useState("");

  const handleSchoolNameChange = (val: string) => {
    setSchoolName(val);
    setSlug(slugify(val));
    // Generate school code from initials
    const words = val.trim().split(/\s+/);
    const code = words.map(w => w[0]?.toUpperCase() || "").join("").substring(0, 4);
    setSchoolCode(code);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schoolName.trim() || !slug.trim() || !email.trim() || !password.trim()) {
      toast.error("Please fill in all required fields");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    try {
      const response = await supabase.functions.invoke("register-school", {
        body: { schoolName, slug, address, phone, schoolEmail, email, password, fullName, schoolCode },
      });

      if (response.error) {
        toast.error(response.error.message || "Registration failed");
        setLoading(false);
        return;
      }

      const data = response.data;
      if (data?.error) {
        toast.error(data.error);
        setLoading(false);
        return;
      }

      // Auto-login the newly registered user
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        toast.error("Registration succeeded but auto-login failed. Please sign in manually.");
        navigate("/login");
        return;
      }

      toast.success("School registered successfully!");
      navigate(`/school/${slug}/admin`);
    } catch (err) {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (step === "done") {
    const portalUrl = `${window.location.origin}/school/${createdSlug}`;
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary/5 p-4">
        <Card className="w-full max-w-md shadow-lg text-center">
          <CardContent className="pt-8 pb-8 space-y-4">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-2xl font-bold">School Registered! 🎉</h2>
            <p className="text-muted-foreground">
              Please check your email to verify your account before logging in.
            </p>
            <div className="bg-muted rounded-lg p-4 text-left space-y-2">
              <p className="text-sm font-medium">Your school portal link:</p>
              <div className="flex items-center gap-2 bg-background rounded-md border p-2">
                <LinkIcon className="w-4 h-4 text-primary shrink-0" />
                <code className="text-sm text-primary break-all">{portalUrl}</code>
              </div>
              <p className="text-xs text-muted-foreground">
                Share this link with your students and staff.
              </p>
            </div>
            <Button className="w-full" onClick={() => navigate(`/school/${createdSlug}`)}>
              Go to Your Portal <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
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
          <h1 className="text-3xl font-bold text-foreground">
            EduLedger<span className="text-primary font-bold">NG</span>
          </h1>
          <p className="text-muted-foreground mt-1">Register Your School</p>
        </div>

        <Card className="shadow-lg border-primary/10">
          <CardHeader>
            <CardTitle>
              {step === "details" ? "School Details" : "Admin Account"}
            </CardTitle>
            <CardDescription>
              {step === "details"
                ? "Enter your school information"
                : "Create your admin login"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {step === "details" ? (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!schoolName.trim()) {
                    toast.error("School name is required");
                    return;
                  }
                  setStep("account");
                }}
              >
                <div className="space-y-2">
                  <Label>School Name *</Label>
                  <Input
                    placeholder="e.g. Bright Horizon Academy"
                    value={schoolName}
                    onChange={(e) => handleSchoolNameChange(e.target.value)}
                    required
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Your School Link</Label>
                  <div className="flex items-center gap-1 text-sm">
                    <span className="text-muted-foreground whitespace-nowrap">
                      {window.location.host}/school/
                    </span>
                    <Input
                      value={slug}
                      onChange={(e) => setSlug(slugify(e.target.value))}
                      className="h-8 text-sm"
                      maxLength={50}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This is the link students will use to access your portal
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>School Code (for Student IDs) *</Label>
                  <Input
                    placeholder="e.g. FA, BHA"
                    value={schoolCode}
                    onChange={(e) => setSchoolCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").substring(0, 5))}
                    maxLength={5}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Used to generate student IDs like {schoolCode || "FA"}/JSS1/001
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Address</Label>
                  <Input
                    placeholder="School address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    maxLength={200}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <Input
                      placeholder="Phone number"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      maxLength={20}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>School Email</Label>
                    <Input
                      type="email"
                      placeholder="info@school.com"
                      value={schoolEmail}
                      onChange={(e) => setSchoolEmail(e.target.value)}
                      maxLength={100}
                    />
                  </div>
                </div>
                <Button type="submit" className="w-full">
                  Next <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </form>
            ) : (
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div className="space-y-2">
                  <Label>Full Name *</Label>
                  <Input
                    placeholder="Your full name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Email *</Label>
                  <Input
                    type="email"
                    placeholder="admin@school.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Password *</Label>
                  <Input
                    type="password"
                    placeholder="Min. 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    maxLength={50}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setStep("details")}
                  >
                    Back
                  </Button>
                  <Button type="submit" className="flex-1" disabled={loading}>
                    {loading ? "Creating..." : "Register School"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground mt-4">
          Already registered?{" "}
          <Button
            variant="link"
            className="p-0 h-auto text-primary"
            onClick={() => navigate("/login")}
          >
            Sign in here
          </Button>
        </p>
      </div>
    </div>
  );
};

export default RegisterSchool;
