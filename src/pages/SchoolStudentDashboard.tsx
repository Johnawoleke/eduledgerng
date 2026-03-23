import React, { useState, useMemo, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSchool } from "@/lib/schoolContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GraduationCap, LogOut, Wallet, CreditCard, History, Eye, Loader2, Banknote, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);

interface AcademicSession {
  id: string;
  name: string;
  is_current: boolean;
  created_at: string;
}

interface AcademicTerm {
  id: string;
  session_id: string;
  name: string;
  is_current: boolean;
  created_at: string;
}

const SchoolStudentDashboard = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { student, school, feeItems, payments, logoutStudent, studentCredentials, setStudentData } = useSchool();

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [selectedFees, setSelectedFees] = useState<Record<string, boolean>>({});
  const [feeAmounts, setFeeAmounts] = useState<Record<string, string>>({});
  const [payingWithZendfi, setPayingWithZendfi] = useState(false);

  // Academic period state
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [terms, setTerms] = useState<AcademicTerm[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedTermId, setSelectedTermId] = useState("");

  // Load academic periods
  useEffect(() => {
    if (!school?.id) return;
    const load = async () => {
      const { data: sessionsData } = await supabase
        .from("academic_sessions")
        .select("*")
        .eq("school_id", school.id)
        .order("created_at", { ascending: false });

      const allSessions = (sessionsData || []) as AcademicSession[];
      setSessions(allSessions);

      const currentSession = allSessions.find((s) => s.is_current) || allSessions[0];
      if (currentSession) setSelectedSessionId(currentSession.id);

      const { data: termsData } = await supabase
        .from("academic_terms")
        .select("*")
        .eq("school_id", school.id)
        .order("created_at", { ascending: true });

      const allTerms = (termsData || []) as AcademicTerm[];
      setTerms(allTerms);

      if (currentSession) {
        const currentTerm = allTerms.find((t) => t.session_id === currentSession.id && t.is_current) ||
          allTerms.find((t) => t.session_id === currentSession.id);
        if (currentTerm) setSelectedTermId(currentTerm.id);
      }
    };
    load();
  }, [school?.id]);

  // Update terms when session changes
  useEffect(() => {
    if (!selectedSessionId || terms.length === 0) return;
    const sessionTerms = terms.filter((t) => t.session_id === selectedSessionId);
    const currentTerm = sessionTerms.find((t) => t.is_current) || sessionTerms[0];
    if (currentTerm) setSelectedTermId(currentTerm.id);
  }, [selectedSessionId, terms]);

  const currentSession = sessions.find((s) => s.is_current);
  const currentTerm = terms.find((t) => t.is_current && t.session_id === currentSession?.id);
  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const termsForSelectedSession = terms.filter((t) => t.session_id === selectedSessionId);

  const isFutureSession = (sessionId: string) => {
    if (!currentSession) return false;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    return session.created_at > currentSession.created_at && !session.is_current;
  };

  const isFutureTerm = (termId: string) => {
    const term = terms.find((t) => t.id === termId);
    if (!term) return false;
    if (isFutureSession(term.session_id)) return true;
    if (term.session_id !== currentSession?.id) return false;
    if (!currentTerm) return false;
    return term.created_at > currentTerm.created_at && !term.is_current;
  };

  const isViewingFuturePeriod = isFutureSession(selectedSessionId) || isFutureTerm(selectedTermId);

  // Filter fee items by selected term (or show all if no term_id on fee - legacy)
  const filteredFeeItems = useMemo(() => {
    if (!selectedTermId) return feeItems;
    return feeItems.filter((f: any) => f.term_id === selectedTermId || !f.term_id);
  }, [feeItems, selectedTermId]);

  // Calculate arrears from previous terms
  const previousTermFees = useMemo(() => {
    if (!currentTerm || !currentSession) return [];
    const previousTermIds = terms
      .filter((t) => t.session_id === currentSession.id && t.created_at < currentTerm.created_at)
      .map((t) => t.id);

    // Also include terms from past sessions
    const pastSessionIds = sessions
      .filter((s) => s.created_at < currentSession.created_at)
      .map((s) => s.id);
    const pastTermIds = terms
      .filter((t) => pastSessionIds.includes(t.session_id))
      .map((t) => t.id);

    const allPrevTermIds = [...previousTermIds, ...pastTermIds];
    return feeItems.filter((f: any) => allPrevTermIds.includes(f.term_id) && f.status !== "paid");
  }, [feeItems, terms, sessions, currentTerm, currentSession]);

  const totalFees = filteredFeeItems.reduce((s, f) => s + Number(f.amount), 0);
  const totalPaid = filteredFeeItems.reduce((s, f) => s + Number(f.paid), 0);
  const balance = totalFees - totalPaid;
  const previousOutstanding = previousTermFees.reduce((s, f) => s + (Number(f.amount) - Number(f.paid)), 0);
  const totalOutstanding = balance + previousOutstanding;

  const unpaidFees = filteredFeeItems.filter((f) => f.status !== "paid");
  // Combine with previous term arrears for payment modal
  const allUnpaidFees = [...previousTermFees, ...unpaidFees].filter(
    (fee, index, self) => self.findIndex((f) => f.id === fee.id) === index
  );

  const toggleFee = (feeId: string) => {
    setSelectedFees((prev) => {
      const next = { ...prev, [feeId]: !prev[feeId] };
      if (!next[feeId]) {
        setFeeAmounts((a) => { const copy = { ...a }; delete copy[feeId]; return copy; });
      } else {
        const fee = allUnpaidFees.find((f) => f.id === feeId);
        if (fee) setFeeAmounts((a) => ({ ...a, [feeId]: String(Number(fee.amount) - Number(fee.paid)) }));
      }
      return next;
    });
  };

  const basePaymentTotal = useMemo(() => {
    return allUnpaidFees.reduce((sum, fee) => {
      if (!selectedFees[fee.id]) return sum;
      const owing = Number(fee.amount) - Number(fee.paid);
      const val = Number(feeAmounts[fee.id] || 0);
      return sum + Math.min(Math.max(val, 0), owing);
    }, 0);
  }, [selectedFees, feeAmounts, allUnpaidFees]);

  const platformFee = Math.round(basePaymentTotal * 0.01);
  const gatewayFee = Math.round(basePaymentTotal * 0.006);
  const bankCharge = Math.round(basePaymentTotal * 0.02);
  const paymentTotal = basePaymentTotal + platformFee + gatewayFee + bankCharge;

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
          <h1 className="text-2xl font-bold">Welcome, {student.name.split(" ")[0]}!</h1>
          <p className="text-primary-foreground/80 mt-1">{student.class} &bull; {selectedSession?.name || student.session} &bull; {termsForSelectedSession.find(t => t.id === selectedTermId)?.name || student.term}</p>
        </div>

        {/* Session & Term Selector */}
        {sessions.length > 0 && (
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <Select value={selectedSessionId} onValueChange={setSelectedSessionId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select session" />
                </SelectTrigger>
                <SelectContent>
                  {sessions.map((s) => (
                    <SelectItem
                      key={s.id}
                      value={s.id}
                      disabled={isFutureSession(s.id)}
                    >
                      {s.name} {s.is_current ? "(Current)" : ""}
                      {isFutureSession(s.id) ? " 🔒" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <Select value={selectedTermId} onValueChange={setSelectedTermId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select term" />
                </SelectTrigger>
                <SelectContent>
                  {termsForSelectedSession.map((t) => (
                    <SelectItem
                      key={t.id}
                      value={t.id}
                      disabled={isFutureTerm(t.id)}
                    >
                      {t.name} {t.is_current ? "(Current)" : ""}
                      {isFutureTerm(t.id) ? " 🔒" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {isViewingFuturePeriod && (
          <Card className="border-destructive/20 bg-destructive/5">
            <CardContent className="pt-6 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-destructive shrink-0" />
              <p className="text-sm text-destructive">Payments not available for future academic periods.</p>
            </CardContent>
          </Card>
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

        {/* Previous outstanding balance */}
        {previousOutstanding > 0 && !isViewingFuturePeriod && (
          <Card className="border-destructive/20 bg-destructive/5">
            <CardContent className="pt-6 space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-destructive">Previous Outstanding Balance</span>
                <span className="font-bold text-destructive">{formatNaira(previousOutstanding)}</span>
              </div>
              <div className="flex justify-between items-center border-t border-destructive/10 pt-2">
                <span className="font-semibold">Total Outstanding</span>
                <span className="text-lg font-bold">{formatNaira(totalOutstanding)}</span>
              </div>
            </CardContent>
          </Card>
        )}

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
                  filteredFeeItems.map((fee) => (
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

        {totalOutstanding > 0 && !isViewingFuturePeriod && (
          <Card className="border-primary/20">
            <CardContent className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <p className="font-semibold">Total Outstanding: {formatNaira(totalOutstanding)}</p>
                <p className="text-sm text-muted-foreground">Select fees to pay online</p>
              </div>
              <Button onClick={openPaymentModal} className="gap-2">
                <Banknote className="w-4 h-4" /> Pay with Bank Transfer (via Zendfi)
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
                    const displayItems = p.items.map((item: string) => {
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
            {allUnpaidFees.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">All fees are paid!</p>
            ) : (
              allUnpaidFees.map((fee) => {
                const owing = Number(fee.amount) - Number(fee.paid);
                const isSelected = !!selectedFees[fee.id];
                const isPreviousTerm = previousTermFees.some((f) => f.id === fee.id);
                return (
                  <div key={fee.id} className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${isSelected ? "border-primary/40 bg-primary/5" : "border-border"} ${isPreviousTerm ? "border-l-4 border-l-destructive/50" : ""}`}>
                    <Checkbox checked={isSelected} onCheckedChange={() => toggleFee(fee.id)} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{fee.name}</span>
                        <Badge variant="outline" className={statusColor(fee.status)}>{fee.status}</Badge>
                      </div>
                      {isPreviousTerm && (
                        <p className="text-xs text-destructive font-medium mt-0.5">Previous term arrears</p>
                      )}
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
          {allUnpaidFees.length > 0 && (
            <div className="border-t pt-4 space-y-3">
              {basePaymentTotal > 0 && (
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">School Fees</span>
                    <span>{formatNaira(basePaymentTotal)}</span>
                  </div>
                  <p className="text-xs font-medium text-muted-foreground pt-1">Service Charges:</p>
                  <div className="flex justify-between pl-2">
                    <span className="text-muted-foreground">• Platform Fee (1%)</span>
                    <span>{formatNaira(platformFee)}</span>
                  </div>
                  <div className="flex justify-between pl-2">
                    <span className="text-muted-foreground">• Gateway Fee (0.6%)</span>
                    <span>{formatNaira(gatewayFee)}</span>
                  </div>
                  <div className="flex justify-between pl-2">
                    <span className="text-muted-foreground">• Bank Charge (2%)</span>
                    <span>{formatNaira(bankCharge)}</span>
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
                disabled={paymentTotal <= 0 || payingWithZendfi}
                onClick={async () => {
                  if (!studentCredentials || !slug) return;
                  setPayingWithZendfi(true);
                  try {
                    const feePayments = allUnpaidFees
                      .filter((f) => selectedFees[f.id])
                      .map((f) => ({
                        fee_item_id: f.id,
                        amount: Math.min(
                          Math.max(Number(feeAmounts[f.id] || 0), 0),
                          Number(f.amount) - Number(f.paid)
                        ),
                      }))
                      .filter((fp) => fp.amount > 0);

                    const { data, error } = await supabase.functions.invoke("create-zendfi-payment", {
                      body: {
                        school_slug: slug,
                        student_id: studentCredentials.student_id,
                        pin: studentCredentials.pin,
                        fee_payments: feePayments,
                      },
                    });

                    if (error || !data?.hosted_page_url) {
                      toast.error(data?.error || "Failed to create payment link. Please try again.");
                      setPayingWithZendfi(false);
                      return;
                    }

                    toast.success("Redirecting to payment page...");
                    setPaymentOpen(false);
                    window.location.href = data.hosted_page_url;
                  } catch (err) {
                    console.error("Zendfi payment error:", err);
                    toast.error("Something went wrong. Please try again.");
                    setPayingWithZendfi(false);
                  }
                }}
              >
                {payingWithZendfi ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
                ) : (
                  <><Banknote className="w-4 h-4" /> Pay {formatNaira(paymentTotal)} via Bank Transfer</>
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
