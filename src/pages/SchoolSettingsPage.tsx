import React, { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Save } from "lucide-react";
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

      // A bursar still on their temporary password must rotate it first.
      const { data: myProfile } = await supabase
        .from("profiles")
        .select("must_change_password")
        .eq("id", user.id)
        .maybeSingle();
      if (myProfile?.must_change_password) { navigate("/change-password"); return; }

      const { data: schoolData } = await supabase
        .from("schools")
        .select("*")
        .eq("slug", slug!)
        .maybeSingle();

      if (!schoolData) { navigate(`/school/${slug}`); return; }

      // Settings (incl. the bank/settlement account) are owner-only. Bursars
      // are members but must not change where student money settles.
      const isOwner = schoolData.owner_id === user.id;
      if (!isOwner) {
        const { data: ownerRow } = await supabase
          .from("school_admins")
          .select("id")
          .eq("school_id", schoolData.id)
          .eq("user_id", user.id)
          .eq("role", "owner")
          .maybeSingle();
        if (!ownerRow) {
          toast.error("Only the school owner can access settings");
          navigate(`/school/${slug}/admin`);
          return;
        }
      }

      setSchool(schoolData);
      setAddress(schoolData.address || "");
      setPhone(schoolData.phone || "");

      // Bank details live in their own member-scoped table. They used to be
      // columns on `schools`, whose SELECT policy is using(true) so the portal
      // can show a school's name before login — which meant every school's
      // account number was readable with the public anon key
      // (migration 20260823120000). A school that has never entered them has
      // no row at all, which is not an error.
      const { data: settlement } = await supabase
        .from("school_settlement")
        .select("bank_name, account_number, account_name")
        .eq("school_id", schoolData.id)
        .maybeSingle();
      setBankName(settlement?.bank_name || "");
      setAccountNumber(settlement?.account_number || "");
      setAccountName(settlement?.account_name || "");
      setLoading(false);
    };
    load();
  }, [slug]);

  // Whether Paystack has released this school for payouts.
  //
  // A school can take fees for a week and receive NOTHING, because Paystack
  // holds the first payout to a new subaccount until someone clicks Verify in
  // its dashboard. There is no API for that, so the least we can do is stop the
  // school finding out from an angry parent.
  const [payoutHold, setPayoutHold] = useState<null | {
    provisioned: boolean; verified: boolean | null;
  }>(null);

  useEffect(() => {
    if (!school?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.functions.invoke("settlement-status", {
        body: { school_id: school.id },
      });
      // Silent on failure. A banner shown because a lookup failed sends a
      // school chasing Paystack support over nothing.
      if (cancelled || error || !data || data.error) return;
      setPayoutHold({ provisioned: !!data.provisioned, verified: data.verified });
    })();
    return () => { cancelled = true; };
  }, [school?.id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (accountNumber && !/^\d{10}$/.test(accountNumber)) {
      toast.error("Account number must be exactly 10 digits");
      return;
    }
    setSaving(true);

    const { error } = await supabase
      .from("schools")
      .update({ address: address || null, phone: phone || null })
      .eq("id", school.id);

    if (error) {
      toast.error("Failed to save: " + error.message);
      setSaving(false);
      return;
    }

    // Upsert, because a school that has never set bank details has no row yet.
    // The cached settlement account id is NOT sent and could not be written if
    // it were — guard_settlement_row strips it from any client write, and
    // clears it outright when the bank details change so the next payment
    // re-provisions instead of settling into the old account.
    const { error: settlementError } = await supabase
      .from("school_settlement")
      .upsert(
        {
          school_id: school.id,
          bank_name: bankName && bankName !== "none" ? bankName : null,
          account_number: accountNumber || null,
          account_name: accountName || null,
        },
        { onConflict: "school_id" }
      );

    if (settlementError) {
      toast.error("Failed to save bank details: " + settlementError.message);
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
            <img src="/logo.jpeg" alt="" className="w-8 h-8 rounded-lg object-contain" />
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
              {/* Only when we KNOW it is false. null means we could not ask. */}
              {payoutHold?.provisioned && payoutHold.verified === false && (
                <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm">
                  <p className="font-medium">Your payouts are on hold</p>
                  <p className="text-muted-foreground mt-1 leading-snug">
                    Paystack holds the first payout to a new bank account until it has been
                    checked once. Fees are still being collected and nothing is lost, but the
                    money will not reach your account until the check is done. We have been
                    told and are clearing it. It only happens once.
                  </p>
                </div>
              )}
              {payoutHold?.provisioned && payoutHold.verified === true && (
                <div className="p-3 rounded-lg border text-sm">
                  <p className="font-medium">Your account is set up for payouts</p>
                  <p className="text-muted-foreground mt-1">
                    Fees you collect settle to the account below.
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label>Bank Name</Label>
                <Select value={bankName} onValueChange={setBankName}>
                  <SelectTrigger><SelectValue placeholder="Select bank" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
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
              <p className="text-xs text-muted-foreground border-t pt-3">
                Payments settle into this account. If you change the bank or account
                number, the next payment re-verifies the new account with Paystack
                before any money moves, so double-check the digits before saving.
              </p>
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
