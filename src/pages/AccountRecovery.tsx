// src/pages/AccountRecovery.tsx
//
// Landing page for the Supabase password-recovery email link. The link signs
// the user in with a recovery session; this page lets them set a new password.
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { KeyRound, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const AccountRecovery = () => {
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  // null = still resolving the recovery session from the URL
  const [sessionReady, setSessionReady] = useState<boolean | null>(null);

  useEffect(() => {
    // The recovery link contains a token in the URL that supabase-js exchanges
    // for a session shortly after load — poll briefly rather than racing it.
    let cancelled = false;
    let attempts = 0;
    const check = async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) {
        setSessionReady(true);
        return;
      }
      attempts += 1;
      if (attempts < 10) {
        setTimeout(check, 500);
      } else {
        setSessionReady(false);
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      toast.error(error.message);
      setSaving(false);
      return;
    }
    toast.success("Password updated! You're signed in.");
    navigate("/main-dashboard");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary/5 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <KeyRound className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">
            EduLedger<span className="text-primary font-bold">NG</span>
          </h1>
          <p className="text-muted-foreground mt-1">Reset Your Password</p>
        </div>

        <Card className="shadow-lg border-primary/10">
          <CardHeader>
            <CardTitle>Choose a New Password</CardTitle>
            <CardDescription>
              {sessionReady === false
                ? "This reset link is invalid or has expired."
                : "Set the new password for your account."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sessionReady === null ? (
              <div className="flex justify-center py-8">
                <div className="w-6 h-6 border-4 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : sessionReady === false ? (
              <div className="space-y-4 text-center py-4">
                <p className="text-sm text-muted-foreground">
                  Request a fresh link from the login page — reset links can only be used once
                  and expire after a while.
                </p>
                <Button className="w-full" onClick={() => navigate("/login")}>
                  Back to Login
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSetPassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="newPassword">New Password</Label>
                  <div className="relative">
                    <Input
                      id="newPassword"
                      type={showPassword ? "text" : "password"}
                      placeholder="Min. 6 characters"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      minLength={6}
                      disabled={saving}
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <Eye className="w-4 h-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type={showPassword ? "text" : "password"}
                    placeholder="Repeat the password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={6}
                    disabled={saving}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={saving}>
                  {saving ? "Saving..." : "Set New Password"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AccountRecovery;
