import React, { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GraduationCap, ArrowLeft, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { NIGERIAN_BANKS } from "@/lib/nigerianBanks";

const SchoolSettingsPage = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [school, setSchool] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { navigate(`/school/${slug}`); return; }

      const { data: schoolData } = await supabase
        .from("schools")
        .select("*")
        .eq("slug", slug!)
        .maybeSingle();

      if (!schoolData) { navigate(`/school/${slug}`); return; }

      setSchool(schoolData);
      setAddress(schoolData.address || "");
      setPhone(schoolData.phone || "");
      setBankName((schoolData as any).bank_name || "");
      setAccountNumber((schoolData as any).account_number || "");
      setAccountName((schoolData as any).account_name || "");
      setLoading(false);
    };
    load();
  }, [slug]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (accountNumber && !/^\d{10}$/.test(accountNumber)) {
      toast.error("Account number must be exactly 10 digits");
      return;
    }
    setSaving(true);

    const { error } = await supabase
      .from("schools")
      .update({
        address: address || null,
        phone: phone || null,
        bank_name: bankName || null,
        account_number: accountNumber || null,
        account_name: accountName || null,
      } as any)
      .eq("id", school.id);

    if (error) {
      toast.error("Failed to save: " + error.message);
    } else {
      toast.success("Settings saved!");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
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
            <span className="font-bold text-lg">{school?.name}</span>
            <Badge variant="outline" className="ml-2 text-xs">Settings</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate(`/school/${slug}/admin`)} className="gap-2">
            <ArrowLeft className="w-4 h-4" /> Back to Dashboard
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 max-w-2xl space-y-6">
        <form onSubmit={handleSave} className="space-y-6">
          {/* School Info */}
          <Card>
            <CardHeader>
              <CardTitle>School Information</CardTitle>
              <CardDescription>Basic school details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>School Name</Label>
                <Input value={school?.name || ""} disabled className="bg-muted" />
              </div>
              <div className="space-y-2">
                <Label>School Email</Label>
                <Input value={school?.email || ""} disabled className="bg-muted" />
              </div>
              <div className="space-y-2">
                <Label>Address</Label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="School address" maxLength={200} />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" maxLength={20} />
              </div>
            </CardContent>
          </Card>

          {/* Bank Details */}
          <Card>
            <CardHeader>
              <CardTitle>Bank Account Details</CardTitle>
              <CardDescription>Add your school's bank details for payment settlement</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Bank Name</Label>
                <Select value={bankName} onValueChange={setBankName}>
                  <SelectTrigger><SelectValue placeholder="Select bank" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— None —</SelectItem>
                    {NIGERIAN_BANKS.map((b) => (
                      <SelectItem key={b} value={b}>{b}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Account Number</Label>
                <Input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, "").substring(0, 10))}
                  placeholder="10-digit account number"
                  maxLength={10}
                  inputMode="numeric"
                />
                {accountNumber && accountNumber.length !== 10 && (
                  <p className="text-xs text-destructive">Must be exactly 10 digits</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Account Name</Label>
                <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Account holder name" maxLength={100} />
              </div>
            </CardContent>
          </Card>

          <Button type="submit" className="w-full gap-2" disabled={saving}>
            <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save Changes"}
          </Button>
        </form>
      </main>
    </div>
  );
};

export default SchoolSettingsPage;
