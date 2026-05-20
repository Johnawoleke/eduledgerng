import React, { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSchool } from "@/lib/schoolContext";

const ChangePinPage = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { student, studentCredentials, loginStudent, school, feeItems, payments } = useSchool();
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [loading, setLoading] = useState(false);

  if (!student || !studentCredentials) {
    navigate(`/school/${slug}`);
    return null;
  }

  const handleChangePin = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
      toast.error("PIN must be exactly 4 digits");
      return;
    }
    if (newPin !== confirmPin) {
      toast.error("PINs do not match");
      return;
    }
    if (newPin === studentCredentials.pin) {
      toast.error("New PIN must be different from your current PIN");
      return;
    }

    setLoading(true);

    try {
      const res = await supabase.functions.invoke("change-pin", {
        body: {
          school_slug: slug,
          student_id: studentCredentials.student_id,
          old_pin: studentCredentials.pin,
          new_pin: newPin,
        },
      });

      if (res.error || res.data?.error) {
        toast.error(res.data?.error || "Failed to change PIN");
        setLoading(false);
        return;
      }

      // 🚀 NEW BACKUP AUTO-UPDATE CODE
      // This tells the database directly to update the visual data grid and turn off the first-time login flag.
      await supabase
        .from('students')
        .update({ 
          pin: newPin,
          is_first_login: false 
        })
        .eq('student_id', studentCredentials.student_id);

      // Re-login with new PIN to update credentials
      loginStudent(
        { ...student, must_change_pin: false },
        feeItems,
        payments,
        { student_id: studentCredentials.student_id, pin: newPin }
      );

      toast.success("PIN changed successfully!");
      navigate(`/school/${slug}/student`);
    } catch {
      toast.error("Failed to change PIN");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary/5 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <KeyRound className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Change Your PIN</h1>
          <p className="text-muted-foreground mt-1">
            Welcome, {student.name.split(" ")[0]}! You must set a personal PIN before continuing.
          </p>
        </div>

        <Card className="shadow-lg border-primary/10">
          <CardHeader>
            <CardTitle>Set New PIN</CardTitle>
            <CardDescription>Choose a 4-digit PIN that only you know. Do not share it with anyone.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleChangePin} className="space-y-4">
              <div className="space-y-2">
                <Label>New PIN (4 digits)</Label>
                <Input
                  type="password"
                  placeholder="••••"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").substring(0, 4))}
                  maxLength={4}
                  required
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-2">
                <Label>Confirm PIN</Label>
                <Input
                  type="password"
                  placeholder="••••"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").substring(0, 4))}
                  maxLength={4}
                  required
                  inputMode="numeric"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Changing..." : "Set New PIN"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default ChangePinPage;
