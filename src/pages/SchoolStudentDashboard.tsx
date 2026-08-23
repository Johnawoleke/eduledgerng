import React, { useState, useMemo, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSchool } from "@/lib/schoolContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LogOut, Wallet, CreditCard, History, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionsError } from "@/lib/utils";
import { quoteCheckout } from "@/lib/gatewayMoney";
import { isSettledPayment } from "@/lib/paymentStatus";
import AcademicPeriodSelector from "@/components/AcademicPeriodSelector";
import { useAcademicPeriods } from "@/hooks/useAcademicPeriods";

// One payable line: a fee for the term on screen, or a debt carried from an
// earlier one. period_label is present only on the latter.
interface PayableFee {
  id: string;
  name: string;
  amount: number;
  paid: number;
  status: string;
  session_id?: string | null;
  term_id?: string | null;
  period_label?: string;
}

const formatNaira = (amount: number) =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount || 0);

const SchoolStudentDashboard = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { student, school, feeItems = [], payments = [], logoutStudent, setStudentData, studentSession, updateStudentSession } = useSchool();

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [selectedFees, setSelectedFees] = useState<Record<string, boolean>>({});
  const [feeAmounts, setFeeAmounts] = useState<Record<string, string>>({});
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentRefreshKey, setPaymentRefreshKey] = useState(0);

  // Change-password dialog
  const [changePwOpen, setChangePwOpen] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [changingPw, setChangingPw] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!student || !studentSession) return;
    if (newPw.length < 6) {
      toast.error("New password must be at least 6 characters");
      return;
    }
    if (newPw !== confirmPw) {
      toast.error("New passwords do not match");
      return;
    }
    if (newPw === currentPw) {
      toast.error("New password must be different from your current one");
      return;
    }
    setChangingPw(true);
    try {
      // Changing a password requires the CURRENT one, not just a session token —
      // otherwise a stolen token would be enough to take the account over.
      const { data, error } = await supabase.functions.invoke("change-pin", {
        body: {
          school_slug: slug,
          student_id: student.student_id,
          old_pin: currentPw,
          new_pin: newPw,
        },
      });
      if (error || data?.error) {
        toast.error(data?.error || (await readFunctionsError(error, "Failed to change password")));
        return;
      }

      // Every session minted under the old password was just revoked server-side.
      if (data?.session_token) {
        updateStudentSession({ token: data.session_token, expiresAt: data.session_expires_at ?? null });
        toast.success("Password changed. You've been signed out on any other devices.");
        setChangePwOpen(false);
        setCurrentPw(""); setNewPw(""); setConfirmPw(""); setShowPw(false);
      } else {
        toast.success("Password changed. Please log in again.");
        logoutStudent();
        navigate(`/school/${slug}`);
      }
    } catch {
      toast.error("An unexpected error occurred");
    } finally {
      setChangingPw(false);
    }
  };

  // EVERYTHING this student still owes, in every term and session. Deliberately
  // not derived from the period selector: that is a browsing control, and with a
  // session chosen but no term it collapsed three terms of debt into "this
  // term". What someone owes must not change with a dropdown.
  const [owing, setOwing] = useState<PayableFee[]>([]);
  // Whether the headline figures really do span every term. They do when
  // student-auth sends them; under the fallback below they cover the selected
  // period only, and a card captioned "all terms" would then be lying — the
  // exact fault this section was rewritten to fix.
  const [allTerms, setAllTerms] = useState({ totals: true, owing: true });
  // The three headline figures, all on the SAME footing: the student's whole
  // position, not a mix of "this period" and "all periods".
  const [totals, setTotals] = useState({ billed: 0, paid: 0, owing: 0 });

  const academicPeriods = useAcademicPeriods(school?.id);

  // Paystack redirects back with ?trxref=...&reference=... — confirm the
  // transaction server-side, then refresh the dashboard data.
  //
  // If a second gateway is ever routed in, check what it names this param:
  // reading only Paystack's names is exactly what broke the confirmation step
  // during the Squad episode, since Squad sent transaction_ref instead.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get("reference") || params.get("trxref");
    if (!reference) return;
    window.history.replaceState({}, "", window.location.pathname);

    (async () => {
      toast.info("Confirming your payment...");
      try {
        const { data, error } = await supabase.functions.invoke("verify-payment", {
          body: { reference },
        });
        if (!error && data?.success) {
          toast.success("Payment confirmed! Your fee balance has been updated.");
          setPaymentRefreshKey((k) => k + 1);
        } else if (data?.reason) {
          // The server says WHY, and the advice differs by cause: a wrong
          // amount is refunded by Paystack automatically, a declined card
          // never moved any money. "Payment was not completed" told a parent
          // who had just sent money nothing at all, so they sent it again.
          toast.error(data.reason, { duration: 15000 });
        } else if (data?.status === "abandoned" || data?.status === "failed") {
          toast.error("Payment was not completed. Please try again.");
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
    if (!student?.id || !studentSession) return;

    // Upcoming (virtual) sessions have no data by definition — show blank
    if (academicPeriods.isFutureSession) {
      setStudentData([], []);
      setOwing([]);
      setTotals({ billed: 0, paid: 0, owing: 0 });
      return;
    }

    const fetchLiveDashboardData = async () => {
      try {
        const { data, error } = await supabase.functions.invoke("student-auth", {
          body: {
            school_slug: slug,
            session_token: studentSession.token,
            session_id: academicPeriods.selectedSessionId || undefined,
            term_id: academicPeriods.selectedTermId || undefined,
          },
        });

        if (!error && data && !data.error) {
          // FALL BACK, never blank. `owing` and `totals` come from a newer
          // student-auth; if the deployed function predates them, deriving from
          // this period's feeItems keeps a payable list on screen. Without this
          // a single missing field removes the pay button entirely and a
          // student simply cannot pay — the worst failure this page has.
          const periodLabel = [
            academicPeriods.selectedSession?.name,
            academicPeriods.selectedTerm?.name,
          ].filter(Boolean).join(" · ") || "This term";

          const fees = (data.feeItems || []) as PayableFee[];
          const derived = fees
            .filter((f) => Number(f.amount || 0) - Number(f.paid || 0) > 0)
            .map((f) => ({ ...f, period_label: f.period_label || periodLabel }));

          setAllTerms({ totals: !!data.totals, owing: Array.isArray(data.owing) });
          setStudentData(data.feeItems || [], data.payments || [], data.student);
          setOwing(Array.isArray(data.owing) ? data.owing : derived);
          setTotals(
            data.totals || {
              billed: fees.reduce((a, f) => a + Number(f.amount || 0), 0),
              paid: fees.reduce((a, f) => a + Number(f.paid || 0), 0),
              owing: derived.reduce((a, f) => a + (Number(f.amount || 0) - Number(f.paid || 0)), 0),
            }
          );
          return;
        }

        // The session expired, or was revoked by a password change / the school
        // resetting this student. Don't keep replaying it — end the session and
        // send them to log in again.
        const status = (error as { context?: { status?: number } })?.context?.status;
        if (status === 401 || data?.error) {
          toast.error("Your session has ended. Please log in again.");
          logoutStudent();
          navigate(`/school/${slug}`);
        }
      } catch (err) {
        console.error("Dashboard refresh failed:", err);
      }
    };

    fetchLiveDashboardData();
  }, [student?.id, studentSession, slug, academicPeriods.isFutureSession, academicPeriods.selectedSessionId, academicPeriods.selectedTermId, academicPeriods.selectedSession?.name, academicPeriods.selectedTerm?.name, setStudentData, paymentRefreshKey, logoutStudent, navigate]);

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

  const totalOwing = owing.reduce(
    (s, f) => s + (Number(f?.amount || 0) - Number(f?.paid || 0)), 0
  );

  // Grouped by the term the debt belongs to, the same shape the school sees.
  const owingByPeriod = useMemo(() => {
    const groups = new Map<string, { label: string; total: number; fees: PayableFee[] }>();
    for (const f of owing) {
      const label = f.period_label || "Earlier";
      const g = groups.get(label) || { label, total: 0, fees: [] };
      g.total += Number(f.amount || 0) - Number(f.paid || 0);
      g.fees.push(f);
      groups.set(label, g);
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [owing]);

  // One list for payment purposes, two lists on screen. create-payment takes
  // each item's period from its own charge, so paying an older term's fee from
  // this screen settles that term, not this one.
  // One list for payment: every outstanding charge, whichever term it is in.
  const payableFees = owing;

  const toggleFee = (feeId: string) => {
    setSelectedFees((prev) => {
      const next = { ...prev, [feeId]: !prev[feeId] };
      if (!next[feeId]) {
        setFeeAmounts((a) => { const copy = { ...a }; delete copy[feeId]; return copy; });
      } else {
        const fee = payableFees.find((f) => f && f.id === feeId);
        if (fee) setFeeAmounts((a) => ({ ...a, [feeId]: String(Number(fee.amount || 0) - Number(fee.paid || 0)) }));
      }
      return next;
    });
  };

  const basePaymentTotal = useMemo(() => {
    return payableFees.reduce((sum, fee) => {
      if (!fee || !selectedFees[fee.id]) return sum;
      const owing = Number(fee.amount || 0) - Number(fee.paid || 0);
      const val = Number(feeAmounts[fee.id] || 0);
      return sum + Math.min(Math.max(val, 0), owing);
    }, 0);
  }, [selectedFees, feeAmounts, payableFees]);

  // The school receives the full fee; our 1% platform charge and the gateway's
  // fee are both added on top (paid by the parent). All the math lives in
  // src/lib/gatewayMoney.ts, which picks the same gateway the server will
  // (selectGateway) and is kept in sync with its Deno copy by the test suite.
  const breakdown = quoteCheckout(basePaymentTotal);
  const platformFee = breakdown.platformKobo / 100;
  const processingFee = breakdown.processingFeeKobo / 100;
  const paymentTotal = breakdown.totalKobo / 100;

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

  // Redirect out in an effect, not during render (calling navigate() in the
  // render body triggers a React "cannot update during render" warning).
  useEffect(() => {
    if (!student) navigate(`/school/${slug}`);
  }, [student, slug, navigate]);

  if (!student) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card no-print">
        <div className="container mx-auto flex items-center justify-between gap-2 h-16 px-4">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <img src="/logo.jpeg" alt="" className="w-8 h-8 rounded-lg object-contain shrink-0" />
            <span className="font-bold text-base sm:text-lg truncate">{school?.name || "School"}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-sm text-muted-foreground hidden sm:inline max-w-[160px] truncate">{student.name}</span>
            <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => setChangePwOpen(true)} title="Change password">
              <KeyRound className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => { logoutStudent(); navigate(`/school/${slug}`); }} title="Log out">
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
        {academicPeriods.sessionOptions && academicPeriods.sessionOptions.length > 0 && (
          <AcademicPeriodSelector
            sessions={academicPeriods.sessionOptions}
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
                  <p className="text-sm text-muted-foreground">Fees so far</p>
                  <p className="text-xl font-bold">{formatNaira(totals.billed)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{allTerms.totals ? "all terms" : "this term"}</p>
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
                  <p className="text-sm text-muted-foreground">Paid so far</p>
                  <p className="text-xl font-bold">{formatNaira(totals.paid)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{allTerms.totals ? "all terms" : "this term"}</p>
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
                  {/* Plain words, and ALWAYS the full figure. This used to say
                      "Owing this term" and show a split derived from the period
                      selector — so with a session picked but no term, three
                      terms of debt were labelled as one. */}
                  <p className="text-sm text-muted-foreground">Still owing</p>
                  <p className="text-xl font-bold">{formatNaira(totalOwing)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{allTerms.owing ? "all terms" : "this term"}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Everything owed, grouped by the term it belongs to — the same shape
            the school sees under its Owing tab. Independent of the session and
            term above: filtering to one period is precisely what hides a debt
            carried from another, so a summary built on that filter can never be
            the whole picture. */}
        {totalOwing > 0 && (
          <Card className="border-destructive/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">What you still owe</CardTitle>
              <p className="text-sm text-muted-foreground">
                {formatNaira(totalOwing)} in total
                {owingByPeriod.length > 1 ? `, across ${owingByPeriod.length} terms.` : "."}
                {" "}This does not change with the session or term above.
              </p>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              {owingByPeriod.map((group) => (
                <div key={group.label} className="rounded-lg border">
                  <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/40 rounded-t-lg">
                    <span className="text-sm font-semibold">{group.label}</span>
                    <span className="text-sm font-semibold">{formatNaira(group.total)}</span>
                  </div>
                  <div className="divide-y">
                    {group.fees.map((fee) => {
                      const left = Number(fee.amount || 0) - Number(fee.paid || 0);
                      return (
                        <div key={fee.id} className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-sm truncate">{fee.name || "Fee"}</p>
                            {Number(fee.paid || 0) > 0 && (
                              <p className="text-xs text-muted-foreground">
                                {formatNaira(Number(fee.paid))} of {formatNaira(Number(fee.amount))} paid
                              </p>
                            )}
                          </div>
                          <span className="text-sm font-medium shrink-0">{formatNaira(left)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <Button className="w-full gap-2" onClick={openPaymentModal}>
                <CreditCard className="w-4 h-4" /> Pay {formatNaira(totalOwing)}
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Fees for {academicPeriods.selectedSession?.name || "this session"}
              {academicPeriods.selectedTerm?.name ? ` · ${academicPeriods.selectedTerm.name}` : ""}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Just this term. Everything you owe is in the card above.
            </p>
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

        {/* Gated on the TOTAL, not this term. Gating on `balance` hid the pay
            button from anyone who owed nothing this term but still carried a
            debt from an earlier one — they could see what they owed and had no
            way to pay it. That is the exact state a new term begins in, before
            its fees are published, so it was the common case rather than an
            edge one. */}


        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <History className="w-5 h-5" /> Payments this term
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {academicPeriods.selectedSession?.name || "This session"}
              {academicPeriods.selectedTerm?.name ? ` · ${academicPeriods.selectedTerm.name}` : ""} only.
            </p>
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
                    <TableHead className="text-right">Status</TableHead>
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
                    // A failed attempt used to render exactly like a successful
                    // one — an amount, and a "View receipt" button beside it. A
                    // parent whose transfer was rejected saw a row that read as
                    // proof of payment. Say what happened, and offer a receipt
                    // only for money that actually arrived.
                    const settled = isSettledPayment(p);
                    const isPending = p.status === "pending";
                    return (
                      <TableRow key={p.id} className={settled ? "" : "text-muted-foreground"}>
                        <TableCell>{p.date ? new Date(p.date).toLocaleDateString("en-NG") : "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{p.reference || "—"}</TableCell>
                        <TableCell className="text-xs">
                          {displayItems.filter(Boolean).join(", ")}
                          {!settled && p.failure_reason && (
                            <p className="mt-1 text-[11px] leading-snug text-destructive">
                              {p.failure_reason}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium">{formatNaira(Number(p.amount || 0))}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={settled ? "secondary" : "outline"} className="text-[11px]">
                            {settled ? "Paid" : isPending ? "Processing" : "Not paid"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {settled ? (
                            <Button variant="ghost" size="sm" onClick={() => navigate(`/school/${slug}/receipt/${p.id}`)} className="gap-1 h-7 text-xs">
                              <Eye className="w-3 h-3" /> View
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
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
              {/* Do not claim the whole payment belongs to the period on screen:
                  an older term's fee is settled against ITS term, and saying
                  otherwise contradicts the labels on the items below. */}
              Each fee is paid against the term it belongs to.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {owingByPeriod.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">All fees are paid!</p>
            ) : (
              owingByPeriod.map((group) => (
                <div key={group.label} className="space-y-2">
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <p className="text-sm font-semibold">{group.label}</p>
                    <span className="text-sm text-muted-foreground">{formatNaira(group.total)}</span>
                  </div>
                  {group.fees.map((fee) => {
                    const owingHere = Number(fee.amount || 0) - Number(fee.paid || 0);
                    const isSelected = !!selectedFees[fee.id];
                    return (
                      <div
                        key={fee.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                          isSelected ? "border-primary/40 bg-primary/5" : "border-border"
                        }`}
                      >
                        <Checkbox checked={isSelected} onCheckedChange={() => toggleFee(fee.id)} className="mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{fee.name || "Unnamed Fee"}</span>
                            <Badge variant="outline" className={statusColor(fee.status || "unpaid")}>
                              {fee.status || "unpaid"}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Total: {formatNaira(Number(fee.amount || 0))} &bull; Paid: {formatNaira(Number(fee.paid || 0))} &bull; Owing: {formatNaira(owingHere)}
                          </p>
                          {isSelected && (
                            <div className="mt-2 flex items-center gap-2">
                              <span className="text-xs text-muted-foreground whitespace-nowrap">Pay:</span>
                              <Input
                                type="number"
                                className="h-8 text-sm"
                                value={feeAmounts[fee.id] || ""}
                                min={1}
                                max={owingHere}
                                onChange={(e) => {
                                  const val = Math.min(Math.max(Number(e.target.value), 0), owingHere);
                                  setFeeAmounts((prev) => ({ ...prev, [fee.id]: String(val || "") }));
                                }}
                              />
                              <span className="text-xs text-muted-foreground whitespace-nowrap">/ {formatNaira(owingHere)}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          {payableFees.length > 0 && (
            <div className="border-t pt-4 space-y-3">
              {basePaymentTotal > 0 && (
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">School Fees</span>
                    <span>{formatNaira(basePaymentTotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Platform Charge (1%)</span>
                    <span>{formatNaira(platformFee)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Payment Processing Fee</span>
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

                    const { data, error } = await supabase.functions.invoke("create-payment", {
                      body: {
                        school_slug: slug,
                        session_token: studentSession?.token,
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

                    toast.success("Redirecting to secure checkout...");
                    setPaymentOpen(false);
                    window.location.href = data.authorization_url;
                  } catch (err) {
                    console.error("Payment error:", err);
                    toast.error("Something went wrong. Please try again.");
                    setProcessingPayment(false);
                  }
                }}
              >
                {processingPayment ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
                ) : (
                  <><CreditCard className="w-4 h-4" /> Pay {formatNaira(paymentTotal)}</>
                )}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Change password */}
      <Dialog open={changePwOpen} onOpenChange={(o) => { setChangePwOpen(o); if (!o) { setCurrentPw(""); setNewPw(""); setConfirmPw(""); setShowPw(false); } }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Change your password</DialogTitle>
            <DialogDescription>
              Enter your current password and choose a new one. You'll use the new password next time you log in.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPw">Current password</Label>
              <Input
                id="currentPw"
                type={showPw ? "text" : "password"}
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                required
                disabled={changingPw}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="newPw">New password</Label>
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setShowPw((s) => !s)}>
                  {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  {showPw ? "Hide" : "Show"}
                </Button>
              </div>
              <Input
                id="newPw"
                type={showPw ? "text" : "password"}
                placeholder="At least 4 characters"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                minLength={4}
                required
                disabled={changingPw}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPw">Confirm new password</Label>
              <Input
                id="confirmPw"
                type={showPw ? "text" : "password"}
                placeholder="Repeat the new password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                minLength={4}
                required
                disabled={changingPw}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setChangePwOpen(false)} disabled={changingPw}>
                Cancel
              </Button>
              <Button type="submit" disabled={changingPw || newPw.length < 4 || newPw !== confirmPw}>
                {changingPw ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Changing...</>) : "Change password"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SchoolStudentDashboard;
