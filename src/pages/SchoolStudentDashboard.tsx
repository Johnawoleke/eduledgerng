import React, { useState, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSchool } from "@/lib/schoolContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GraduationCap, LogOut, Wallet, CreditCard, History, Eye } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);

const SchoolStudentDashboard = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { student, school, feeItems, payments, logoutStudent, studentCredentials, setStudentData } = useSchool();

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [processingOpen, setProcessingOpen] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [selectedFees, setSelectedFees] = useState<Record<string, boolean>>({});
  const [feeAmounts, setFeeAmounts] = useState<Record<string, string>>({});

  const totalFees = feeItems.reduce((s, f) => s + Number(f.amount), 0);
  const totalPaid = feeItems.reduce((s, f) => s + Number(f.paid), 0);
  const balance = totalFees - totalPaid;

  const unpaidFees = feeItems.filter((f) => f.status !== "paid");

  const toggleFee = (feeId: string) => {
    setSelectedFees((prev) => {
      const next = { ...prev, [feeId]: !prev[feeId] };
      if (!next[feeId]) {
        setFeeAmounts((a) => { const copy = { ...a }; delete copy[feeId]; return copy; });
      } else {
        const fee = feeItems.find((f) => f.id === feeId);
        if (fee) setFeeAmounts((a) => ({ ...a, [feeId]: String(Number(fee.amount) - Number(fee.paid)) }));
      }
      return next;
    });
  };

  const paymentTotal = useMemo(() => {
    return unpaidFees.reduce((sum, fee) => {
      if (!selectedFees[fee.id]) return sum;
      const owing = Number(fee.amount) - Number(fee.paid);
      const val = Number(feeAmounts[fee.id] || 0);
      return sum + Math.min(Math.max(val, 0), owing);
    }, 0);
  }, [selectedFees, feeAmounts, unpaidFees]);

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

  const forcePaystackIframeVisible = () => {
    // Find and force-show Paystack iframes that may be hidden on mobile
    const iframes = document.querySelectorAll('iframe[name^="paystack"]');
    console.log("[Paystack Debug] Found iframes:", iframes.length);
    iframes.forEach((iframe) => {
      const el = iframe as HTMLIFrameElement;
      console.log("[Paystack Debug] iframe name:", el.name, "display:", el.style.display, "visibility:", el.style.visibility);
      if (el.name.includes("checkout") && !el.name.includes("background")) {
        el.style.position = "fixed";
        el.style.top = "0";
        el.style.left = "0";
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.zIndex = "2147483647";
        el.style.display = "block";
        el.style.visibility = "visible";
      }
      if (el.name.includes("background")) {
        el.style.position = "fixed";
        el.style.top = "0";
        el.style.left = "0";
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.zIndex = "2147483646";
        el.style.display = "block";
        el.style.visibility = "visible";
      }
    });
  };

  const handlePayPaystack = () => {
    console.log("[Paystack Debug] handlePayPaystack called");
    console.log("[Paystack Debug] PaystackPop available:", typeof window.PaystackPop !== "undefined");

    // Check PaystackPop is available
    if (typeof window.PaystackPop === "undefined") {
      toast.error(
        "Paystack payment gateway failed to load. Please refresh the page and try again.",
        { duration: 8000 }
      );
      return;
    }

    const feePayments = unpaidFees
      .filter((f) => selectedFees[f.id])
      .map((f) => ({
        fee_item_id: f.id,
        amount: Math.min(Number(feeAmounts[f.id] || 0), Number(f.amount) - Number(f.paid)),
      }))
      .filter((fp) => fp.amount > 0);

    if (feePayments.length === 0 || paymentTotal <= 0) {
      toast.error("Please select at least one fee and enter an amount.");
      return;
    }

    const amountKobo = Math.round(paymentTotal * 100);
    console.log("[Paystack Debug] amountKobo:", amountKobo);
    if (amountKobo < 100) {
      toast.error("Minimum payment amount is ₦1.");
      return;
    }

    const paystackKey = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY || "pk_test_22f2038e11f810aef2b6df8898c27bba64c6f42c";
    const studentEmail = `${student!.student_id}@${slug}.eduledgerng.com`;
    const reference = `EL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    console.log("[Paystack Debug] key:", paystackKey.substring(0, 10) + "...");
    console.log("[Paystack Debug] email:", studentEmail);
    console.log("[Paystack Debug] reference:", reference);

    // Show loading indicator and close modal
    setPaymentLoading(true);
    setPaymentOpen(false);

    try {
      console.log("[Paystack Debug] Calling PaystackPop.setup...");
      const handler = window.PaystackPop.setup({
        key: paystackKey,
        email: studentEmail,
        amount: amountKobo,
        currency: "NGN",
        ref: reference,
        metadata: {
          student_id: student!.student_id,
          student_name: student!.name,
          school_slug: slug,
          custom_fields: [
            { display_name: "Student", variable_name: "student", value: student!.name },
            { display_name: "School", variable_name: "school", value: school?.name || slug },
            { display_name: "Class", variable_name: "class", value: student!.class },
          ],
        },
        callback: async (response: { reference: string }) => {
          setPaymentLoading(false);
          setProcessingOpen(true);
          try {
            const res = await supabase.functions.invoke("verify-payment", {
              body: {
                reference: response.reference,
                school_slug: slug,
                student_id: studentCredentials?.student_id,
                pin: studentCredentials?.pin,
                fee_payments: feePayments,
              },
            });

            if (res.error || res.data?.error) {
              const errMsg = res.data?.error || res.error?.message || "Payment verification failed.";
              toast.error(errMsg + " Please contact support with ref: " + response.reference, { duration: 10000 });
              setProcessingOpen(false);
              return;
            }

            const refreshRes = await supabase.functions.invoke("student-auth", {
              body: {
                school_slug: slug,
                student_id: studentCredentials?.student_id,
                pin: studentCredentials?.pin,
              },
            });

            if (refreshRes.data && !refreshRes.data.error) {
              setStudentData(refreshRes.data.feeItems, refreshRes.data.payments);
            }

            setProcessingOpen(false);
            toast.success("Payment successful! Redirecting to receipt...");

            const paymentId = res.data?.payment?.id || "latest";
            navigate(`/school/${slug}/receipt/${paymentId}`);
          } catch (err) {
            console.error("Payment verification error:", err);
            toast.error("Verification error. Contact support with ref: " + response.reference, { duration: 10000 });
            setProcessingOpen(false);
          }
        },
        onClose: () => {
          console.log("[Paystack Debug] Paystack popup closed by user");
          setPaymentLoading(false);
          toast.info("Payment window closed. No charge was made.");
        },
      });

      console.log("[Paystack Debug] handler created, calling openIframe...");
      handler.openIframe();
      console.log("[Paystack Debug] openIframe called successfully");

      // Force visibility after a short tick to ensure Paystack has created its iframes
      requestAnimationFrame(() => {
        forcePaystackIframeVisible();
        // Check again after another frame
        requestAnimationFrame(() => {
          forcePaystackIframeVisible();
        });
      });
    } catch (err) {
      console.error("[Paystack Debug] Setup error:", err);
      setPaymentLoading(false);
      toast.error("Failed to open payment window. Please refresh and try again.", { duration: 8000 });
    }
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
          <h1 className="text-2xl font-bold">Welcome, {student.name.split(" ")[0]}!</h1>
          <p className="text-primary-foreground/80 mt-1">{student.class} &bull; {student.term} &bull; {student.session}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Wallet className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Fees</p>
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
                {feeItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                      No fees have been set for your class yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  feeItems.map((fee) => (
                    <TableRow key={fee.id}>
                      <TableCell className="font-medium">{fee.name}</TableCell>
                      <TableCell className="text-right">{formatNaira(Number(fee.amount))}</TableCell>
                      <TableCell className="text-right">{formatNaira(Number(fee.paid))}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={statusColor(fee.status)}>{fee.status}</Badge>
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
                <p className="font-semibold">Outstanding Balance: {formatNaira(balance)}</p>
                <p className="text-sm text-muted-foreground">Select fees to pay online via Paystack</p>
              </div>
              <Button onClick={openPaymentModal} className="gap-2">
                <CreditCard className="w-4 h-4" /> Make Payment
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><History className="w-5 h-5" /> Payment History</CardTitle>
          </CardHeader>
          <CardContent>
            {payments.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-4">No payments yet.</p>
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
                  {payments.map((p) => {
                    const displayItems = p.items.map((item) => {
                      const pipeIdx = item.lastIndexOf("|");
                      return pipeIdx > 0 ? item.substring(0, pipeIdx) : item;
                    });
                    return (
                      <TableRow key={p.id}>
                        <TableCell>{new Date(p.date).toLocaleDateString("en-NG")}</TableCell>
                        <TableCell className="font-mono text-xs">{p.reference}</TableCell>
                        <TableCell className="text-xs">{displayItems.join(", ")}</TableCell>
                        <TableCell className="text-right font-medium">{formatNaira(Number(p.amount))}</TableCell>
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
            <DialogDescription>Tick fees and adjust amounts for partial payments.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {unpaidFees.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">All fees are paid!</p>
            ) : (
              unpaidFees.map((fee) => {
                const owing = Number(fee.amount) - Number(fee.paid);
                const isSelected = !!selectedFees[fee.id];
                return (
                  <div key={fee.id} className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${isSelected ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                    <Checkbox checked={isSelected} onCheckedChange={() => toggleFee(fee.id)} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{fee.name}</span>
                        <Badge variant="outline" className={statusColor(fee.status)}>{fee.status}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Total: {formatNaira(Number(fee.amount))} &bull; Paid: {formatNaira(Number(fee.paid))} &bull; Owing: {formatNaira(owing)}
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
              <div className="flex items-center justify-between">
                <span className="font-semibold">Total to Pay:</span>
                <span className="text-xl font-bold text-primary">{formatNaira(paymentTotal)}</span>
              </div>
              <Button
                className="w-full gap-2"
                disabled={paymentTotal <= 0}
                onClick={handlePayPaystack}
              >
                <CreditCard className="w-4 h-4" /> Pay {formatNaira(paymentTotal)} via Paystack
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Processing Dialog */}
      <Dialog open={processingOpen}>
        <DialogContent className="text-center">
          <div className="py-8">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="font-semibold">Verifying payment...</p>
            <p className="text-sm text-muted-foreground">Please wait, do not close this window</p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Paystack Loading Overlay - shows while waiting for Paystack to open */}
      {paymentLoading && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center" style={{ zIndex: 2147483640 }}>
          <div className="text-center space-y-3">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="font-semibold">Opening payment window...</p>
            <p className="text-sm text-muted-foreground">If nothing appears, please refresh and try again</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default SchoolStudentDashboard;
