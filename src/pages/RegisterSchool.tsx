// src/pages/RegisterSchool.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GraduationCap, RefreshCw, Building2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { NIGERIAN_BANKS } from "@/lib/nigerianBanks";

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const getBaseSlug = (name: string) => {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned.substring(0, 5) || "school";
};

const generateUniqueSlug = async (base: string): Promise<string> => {
  let slug = base;
  let attempt = 0;
  while (attempt < 20) {
    const { data } = await supabase
      .from("schools")
      .select("slug")
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return slug;
    const random = Math.floor(1000 + Math.random() * 9000);
    slug = `${base}-${random}`;
    attempt++;
  }
  return `${base}-${Date.now().toString(36)}`;
};

const RegisterSchool = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [showWelcomeModal, setShowWelcomeModal] = useState(
    searchParams.get("welcome") === "true"
  );

  const [loading, setLoading] = useState(false);
  const [schoolName, setSchoolName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [schoolEmail, setSchoolEmail] = useState("");
  const [schoolCode, setSchoolCode] = useState("");
  const [slug, setSlug] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [isGeneratingSlug, setIsGeneratingSlug] = useState(false);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const checkUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error("Please sign in first");
        navigate("/owner-login");
        return;
      }
      setUserId(user.id);
    };
    checkUser();
  }, [navigate]);

  useEffect(() => {
    if (!schoolName.trim()) {
      setSlug("");
      return;
    }
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    const base = getBaseSlug(schoolName);
    setSlug(base);
    setIsGeneratingSlug(true);
    debounceTimer.current = setTimeout(async () => {
      try {
        const uniqueSlug = await generateUniqueSlug(base);
        setSlug(uniqueSlug);
      } catch (err) {
        console.error("Error generating slug:", err);
        setSlug(base);
      } finally {
        setIsGeneratingSlug(false);
      }
    }, 500);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [schoolName]);

  const handleSchoolNameChange = (val: string) => {
    setSchoolName(val);
    const words = val.trim().split(/\s+/);
    const code = words
      .map((w) => w[0]?.toUpperCase() || "")
      .join("")
      .substring(0, 4);
    setSchoolCode(code);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const finalSchoolCode = schoolCode.trim() || slug.substring(0, 4).toUpperCase();
    let finalSlug = slug.trim();

    if (!schoolName.trim() || !finalSlug || !finalSchoolCode) {
      toast.error("School Name, Slug, and School Code are required");
      return;
    }
    if (accountNumber && !/^\d{10}$/.test(accountNumber)) {
      toast.error("Account number must be exactly 10 digits");
      return;
    }
    if (!userId) {
      toast.error("You must be logged in to register a school");
      navigate("/owner-login");
      return;
    }

    setLoading(true);

    try {
      // Final check
      const { data: existing } = await supabase
        .from("schools")
        .select("slug")
        .eq("slug", finalSlug)
        .maybeSingle();

      if (existing) {
        const base = getBaseSlug(schoolName);
        const newSlug = await generateUniqueSlug(base);
        finalSlug = newSlug;
        setSlug(newSlug);
        toast.info(`Slug updated to: ${newSlug}`);
      }

      const payload = {
        schoolName,
        slug: finalSlug,
        address,
        phone,
        schoolEmail,
        schoolCode: finalSchoolCode,
        bankName: bankName && bankName !== "none" ? bankName : null,
        accountNumber: accountNumber || null,
        accountName: accountName || null,
        owner_id: userId,
      };

      const { data, error } = await supabase.functions.invoke("register-school", {
        body: payload,
      });

      if (error) {
        let errorMsg = "Registration failed. Please try again.";
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
        } catch (parseErr) {
          if (error.message) errorMsg = error.message;
        }
        toast.error(errorMsg);
        setLoading(false);
        return;
      }

      if (data?.error) {
        toast.error(data.error);
        setLoading(false);
        return;
      }

      toast.success(`School "${schoolName}" registered successfully!`);
      navigate(`/school/${finalSlug}/admin`);
    } catch (err) {
      console.error("🔥 Unexpected error:", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshSlug = () => {
    if (!schoolName.trim()) return;
    const base = getBaseSlug(schoolName);
    setSlug(base);
    setIsGeneratingSlug(true);
    generateUniqueSlug(base)
      .then((unique) => setSlug(unique))
      .catch(() => setSlug(base))
      .finally(() => setIsGeneratingSlug(false));
  };

  const handleSkipRegistration = () => {
    setShowWelcomeModal(false);
    navigate("/main-dashboard");
  };

  const handleContinueRegistration = () => {
    setShowWelcomeModal(false);
  };

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
            <CardTitle>School Details</CardTitle>
            <CardDescription>
              Enter your school information. You must be logged in as an admin.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Form fields – unchanged */}
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
                <Label>Your School Link (auto‑generated)</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {window.location.host}/school/
                  </span>
                  <Input
                    value={slug}
                    className="h-8 text-sm bg-muted"
                    readOnly
                    disabled={isGeneratingSlug}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRefreshSlug}
                    disabled={!schoolName.trim() || isGeneratingSlug}
                    title="Regenerate unique slug"
                  >
                    <RefreshCw className={`w-3 h-3 ${isGeneratingSlug ? "animate-spin" : ""}`} />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {isGeneratingSlug
                    ? "Checking availability…"
                    : "This link is automatically generated and guaranteed unique."}
                </p>
              </div>

              <div className="space-y-2">
                <Label>School Code (for Student IDs) *</Label>
                <Input
                  placeholder="e.g. FA, BHA"
                  value={schoolCode}
                  onChange={(e) =>
                    setSchoolCode(
                      e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, "")
                        .substring(0, 5)
                    )
                  }
                  maxLength={5}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Used to generate student IDs like {schoolCode || "FA"}
                  /JSS1/001
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

              {/* Optional Bank Details */}
              <div className="border-t pt-4 mt-2">
                <p className="text-sm font-medium text-muted-foreground mb-3">
                  Bank Details (Optional)
                </p>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Bank Name</Label>
                    <Select value={bankName} onValueChange={setBankName}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select bank" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— Skip —</SelectItem>
                        {NIGERIAN_BANKS.map((b) => (
                          <SelectItem key={b} value={b}>
                            {b}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Account Number</Label>
                    <Input
                      placeholder="10-digit account number"
                      value={accountNumber}
                      onChange={(e) =>
                        setAccountNumber(
                          e.target.value.replace(/\D/g, "").substring(0, 10)
                        )
                      }
                      maxLength={10}
                      inputMode="numeric"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Account Name</Label>
                    <Input
                      placeholder="Account holder name"
                      value={accountName}
                      onChange={(e) => setAccountName(e.target.value)}
                      maxLength={100}
                    />
                  </div>
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loading || isGeneratingSlug}>
                {loading ? "Registering..." : "Register School"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground mt-4">
          Already have a school?{" "}
          <Button
            variant="link"
            className="p-0 h-auto text-primary"
            onClick={() => navigate("/owner-login")}
          >
            Sign in
          </Button>
        </p>
      </div>

      {/* Welcome Modal */}
      <Dialog open={showWelcomeModal} onOpenChange={setShowWelcomeModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-2xl text-center">🎉 Welcome to EduLedgerNG!</DialogTitle>
            <DialogDescription className="text-center text-base">
              You've successfully created your admin account.
            </DialogDescription>
          </DialogHeader>
          <div className="py-6 text-center space-y-4">
            <Building2 className="w-16 h-16 text-primary mx-auto" />
            <p className="text-muted-foreground">
              Would you like to register your school now?
            </p>
          </div>
          <DialogFooter className="flex flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={handleSkipRegistration}
            >
              Skip for now
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={handleContinueRegistration}
            >
              Register School
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RegisterSchool;