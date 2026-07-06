import React, { useState, useMemo, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSchool } from "@/lib/schoolContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GraduationCap, LogOut, Wallet, CreditCard, History, Eye, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionsError } from "@/lib/utils";
import AcademicPeriodSelector from "@/components/AcademicPeriodSelector";
import { useAcademicPeriods } from "@/hooks/useAcademicPeriods";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount || 0);

// Paystack NGN pricing: 1.5% + ₦100 (the ₦100 waived under ₦2,500), capped at
// ₦2,000. The checkout total is grossed-up so the school still receives the
// full fee amount — must stay in sync with create-paystack-payment.
const paystackFeeKobo = (amountKobo: number) => {
  let fee = 0.015 * amountKobo;
  if (amountKobo >= 250_000) fee += 10_000;
  return Math.min(Math.ceil(fee), 200_000);
};

const grossUpKobo = (baseKobo: number) => {
  if (baseKobo <= 0) return 0;
  let total =
    baseKobo >= 246_250 ? Math.ceil((baseKobo + 10_000) / 0.985) : Math.ceil(baseKobo / 0.985);
  if (0.015 * total + 10_000 > 200_000) total = baseKobo + 200_000;
  while (total - paystackFeeKobo(total) < baseKobo) total += 100;
  return total;
};

const SchoolStudentDashboard = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { student, school, feeItems = [], payments = [], logoutStudent, setStudentData, studentCredentials } = useSchool();

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [selectedFees, setSelectedFees] = useState<Record<string, boolean>>({});
  const [feeAmounts, setFeeAmounts] = useState<Record<string, string>>({});
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentRefreshKey, setPaymentRefreshKey] = useState(0);

  const academicPeriods = useAcademicPeriods(school?.id);

  // Paystack redirects back with ?trxref=...&reference=... — confirm the
  // transaction server-side, then refresh the dashboard data.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get("reference") || params.get("trxref");
    if (!reference) return;
    window.history.replaceState({}, "", window.location.pathname);

    (async () => {
      toast.info("Confirming your payment...");
      try {
        const { data, error } = await supabase.functions.invoke("verify-paystack-payment", {
          body: { reference },
        });
        if (!error && data?.success) {
          toast.success("Payment confirmed! Your fee balance has been updated.");
          setPaymentRefreshKey((k) => k + 1);
        } else if (data?.status === "abandoned" || data?.status === "failed") {
          toast.error("Payment was not completed.");
        } else {
          toast.info("Payment is still processing — your balance will update shortly.");
        }
      } catch (err) {
        console.error("Payment verification failed:", err);
        toast.error("Could not confirm payment status. Refresh in a moment.");
      }
    })();
  }, []);

  // Refresh fees & payments for the selected period. The student-auth function
  // recomputes fee items (class fees minus payments) server-side, so the
  // browser never touches the students/pin tables directly.
  useEffect(() => {
    if (!student?.id || !studentCredentials) return;

    const fetchLiveDashboardData = async () => {
      try {
        const { data, error } = await supabase.functions.invoke("student-auth", {
          body: {
            school_slug: slug,
            student_id: studentCredentials.student_id,
            pin: studentCredentials.pin,
            session_id: academicPeriods.selectedSessionId || undefined,
            term_id: academicPeriods.selectedTermId || undefined,
          },
        });

        if (!error && data && !data.error) {
          setStudentData(data.feeItems || [], data.payments || []);
        }
      } catch (err) {
        console.error("Dashboard refresh failed:", err);
      }
    };

    fetchLiveDashboardData();
  }, [student?.id, studentCredentials, slug, academicPeriods.selectedSessionId, academicPeriods.selectedTermId, setStudentData, paymentRefreshKey]);

  // Filter fee items safely fallback
  const filteredFeeItems = useMemo(() => {
    const items = feeItems || [];
    if (!academicPeriods.selectedTermId) return items;
    return items.filter((f: any) =>
      f && (f.term_id === academicPeriods.selectedTermId || (!f.term_id && !f.session_id))
    );
  }, [feeItems, academicPeriods.selectedTermId]);

  // Filter payments safely fallback
  const filteredPayments = useMemo(() => {
    const pays = payments || [];
    if (!academicPeriods.selectedTermId) return pays;
    return pays.filter((p: any) =>
      p && (p.term_id === academicPeriods.selectedTermId || (!p.term_id && !p.session_id))
    );
  }, [payments, academicPeriods.selectedTermId]);

  // SAFE MATH PROTECTION: Fallback to 0 if values are missing
  const totalFees = filteredFeeItems.reduce((s, f) => s + Number(f?.amount || 0), 0);
  const totalPaid = filteredFeeItems.reduce((s, f) => s + Number(f?.paid || 0), 0);
  const balance = Math.max(totalFees - totalPaid, 0);

  const unpaidFees = filteredFeeItems.filter((f) => f && f.status !== "paid");

  const toggleFee = (feeId: string) => {
    setSelectedFees((prev) => {
      const next = { ...prev, [feeId]: !prev[feeId] };
      if (!next[feeId]) {
        setFeeAmounts((a) => { const copy = { ...a }; delete copy[feeId]; return copy; });
      } else {
        const fee = unpaidFees.find((f) => f && f.id === feeId);
        if (fee) setFeeAmounts((a) => ({ ...a, [feeId]: String(Number(fee.amount || 0) - Number(fee.paid || 0)) }));
      }
      return next;
    });
  };

  const basePaymentTotal = useMemo(() => {
    return unpaidFees.reduce((sum, fee) => {
      if (!fee || !selectedFees[fee.id]) return sum;
      const owing = Number(fee.amount || 0) - Number(fee.paid || 0);
      const val = Number(feeAmounts[fee.id] || 0);
      return sum + Math.min(Math.max(val, 0), owing);
    }, 0);
  }, [selectedFees, feeAmounts, unpaidFees]);

  const totalKobo = grossUpKobo(Math.round(basePaymentTotal * 100));
  const processingFee = Math.max(totalKobo / 100 - basePaymentTotal, 0);
  const paymentTotal = totalKobo / 100;

  const openPaymentModal = () => {
    setSelectedFees({});
    setFeeAmounts({});
    setPaymentOpen(true);
  };

  const statusColor = (status: string) => {
    if (status === "paid") return "bg-primary/15 text-primary border-primary/30";
    if (status === "partial") return "bg-accent/15 text-accent-foreground border-accent/30";
    return "bg-destructive/10 text-destructive border-destructive/30";
  };

  if (!student) {
    navigate(`/school/${slug}`);
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card no-print">
        <div className="container mx-auto flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">{school?.name || "School"}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground hidden sm:inline">{student.name}</span>
            <Button variant="ghost" size="sm" onClick={() => { logoutStudent(); navigate(`/school/${slug}`); }}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6 max-w-4xl">
        <div className="bg-primary rounded-xl p-6 text-primary-foreground">
          <h1 className="text-2xl font-bold">Welcome, {student.name ? student.name.split(" ")[0] : "Student"}!</h1>
          <p className="text-primary-foreground/80 mt-1">
            Class: {student.class || "Unassigned"} &bull; {academicPeriods.selectedSession?.name || "Current Session"} &bull; {academicPeriods.selectedTerm?.name || "Current Term"}
          </p>
        </div>

        {/* Session & Term Selector */}
        {academicPeriods.sessions && academicPeriods.sessions.length > 0 && (
          <AcademicPeriodSelector
            sessions={academicPeriods.sessions}
            termsForSelectedSession={academicPeriods.termsForSelectedSession || []}
            selectedSessionId={academicPeriods.selectedSessionId}
            selectedTermId={academicPeriods.selectedTermId}
            onSessionChange={academicPeriods.setSelectedSessionId}
            onTermChange={academicPeriods.setSelectedTermId}
          />
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Wallet className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Term Fees</p>
                  <p className="text-xl font-bold">{formatNaira(totalFees)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <CreditCard className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Amount Paid</p>
                  <p className="text-xl font-bold">{formatNaira(totalPaid)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center">
                  <Wallet className="w-5 h-5 text-destructive" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Balance</p>
                  <p className="text-xl font-bold">{formatNaira(balance)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Fee Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fee Item</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredFeeItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                      No fees have been set for this period yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredFeeItems.map((fee) => fee && (
                    <TableRow key={fee.id}>
                      <TableCell className="font-medium">{fee.name || "Unnamed Fee"}</TableCell>
                      <TableCell className="text-right">{formatNaira(Number(fee.amount || 0))}</TableCell>
                      <TableCell className="text-right">{formatNaira(Number(fee.paid || 0))}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={statusColor(fee.status || "unpaid")}>{fee.status || "unpaid"}</Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {balance > 0 && (
          <Card className="border-primary/20">
            <CardContent className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <p className="font-semibold">Balance: {formatNaira(balance)}</p>
                <p className="text-sm text-muted-foreground">Select fees to pay online</p>
              </div>
              <Button onClick={openPaymentModal} className="gap-2">
                <CreditCard className="w-4 h-4" /> Pay Fees Online
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><History className="w-5 h-5" /> Payment History</CardTitle>
          </CardHeader>
          <CardContent>
            {filteredPayments.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-4">No payments for this period.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Receipt</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPayments.map((p) => {
                    if (!p) return null;
                    const displayItems = p.items ? p.items.map((item: string) => {
                      if (!item) return "";
                      const pipeIdx = item.lastIndexOf("|");
                      return pipeIdx > 0 ? item.substring(0, pipeIdx) : item;
                    }) : [];
                    return (
                      <TableRow key={p.id}>
                        <TableCell>{p.date ? new Date(p.date).toLocaleDateString("en-NG") : "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{p.reference || "—"}</TableCell>
                        <TableCell className="text-xs">{displayItems.filter(Boolean).join(", ")}</TableCell>
                        <TableCell className="text-right font-medium">{formatNaira(Number(p.amount || 0))}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => navigate(`/school/${slug}/receipt/${p.id}`)} className="gap-1 h-7 text-xs">
                            <Eye className="w-3 h-3" /> View
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Payment Modal */}
      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Select Fees to Pay</DialogTitle>
            <DialogDescription>
              Payment for {academicPeriods.selectedSession?.name || "—"} — {academicPeriods.selectedTerm?.name || "—"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {unpaidFees.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">All fees are paid!</p>
            ) : (
              unpaidFees.map((fee) => {
                if (!fee) return null;
                const owing = Number(fee.amount || 0) - Number(fee.paid || 0);
                const isSelected = !!selectedFees[fee.id];
                return (
                  <div key={fee.id} className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${isSelected ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                    <Checkbox checked={isSelected} onCheckedChange={() => toggleFee(fee.id)} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{fee.name || "Unnamed Fee"}</span>
                        <Badge variant="outline" className={statusColor(fee.status || "unpaid")}>{fee.status || "unpaid"}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Total: {formatNaira(Number(fee.amount || 0))} &bull; Paid: {formatNaira(Number(fee.paid || 0))} &bull; Owing: {formatNaira(owing)}
                      </p>
                      {isSelected && (
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-xs text-muted-foreground whitespace-nowrap">Pay:</span>
                          <Input
                            type="number"
                            className="h-8 text-sm"
                            value={feeAmounts[fee.id] || ""}
                            min={1}
                            max={owing}
                            onChange={(e) => {
                              const val = Math.min(Math.max(Number(e.target.value), 0), owing);
                              setFeeAmounts((prev) => ({ ...prev, [fee.id]: String(val || "") }));
                            }}
                          />
                          <span className="text-xs text-muted-foreground whitespace-nowrap">/ {formatNaira(owing)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {unpaidFees.length > 0 && (
            <div className="border-t pt-4 space-y-3">
              {basePaymentTotal > 0 && (
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">School Fees</span>
                    <span>{formatNaira(basePaymentTotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Card/Transfer Processing Fee</span>
                    <span>{formatNaira(processingFee)}</span>
                  </div>
                  <div className="border-t my-1" />
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="font-semibold">Total to Pay:</span>
                <span className="text-xl font-bold text-primary">{formatNaira(paymentTotal)}</span>
              </div>
              <Button
                className="w-full gap-2"
                disabled={paymentTotal <= 0 || processingPayment}
                onClick={async () => {
                  setProcessingPayment(true);
                  try {
                    const feePayments = unpaidFees
                      .filter((f) => f && selectedFees[f.id])
                      .map((f) => ({
                        fee_item_id: f.id,
                        amount: Math.min(
                          Math.max(Number(feeAmounts[f.id] || 0), 0),
                          Number(f.amount || 0) - Number(f.paid || 0)
                        ),
                      }))
                      .filter((fp) => fp.amount > 0);

                    const { data, error } = await supabase.functions.invoke("create-paystack-payment", {
                      body: {
                        school_slug: slug,
                        student_id: student.student_id,
                        pin: studentCredentials?.pin,
                        fee_payments: feePayments,
                        session_id: academicPeriods.selectedSessionId,
                        term_id: academicPeriods.selectedTermId,
                        callback_url: `${window.location.origin}/school/${slug}/student`,
                      },
                    });

                    if (error || !data?.authorization_url) {
                      toast.error(
                        data?.error || (await readFunctionsError(error, "Failed to start payment. Please try again."))
                      );
                      setProcessingPayment(false);
                      return;
                    }

                    toast.success("Redirecting to secure Paystack checkout...");
                    setPaymentOpen(false);
                    window.location.href = data.authorization_url;
                  } catch (err) {
                    console.error("Paystack payment error:", err);
                    toast.error("Something went wrong. Please try again.");
                    setProcessingPayment(false);
                  }
                }}
              >
                {processingPayment ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
                ) : (
                  <><CreditCard className="w-4 h-4" /> Pay {formatNaira(paymentTotal)} with Paystack</>
                )}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SchoolStudentDashboard;
