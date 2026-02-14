import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/authContext";
import { feeStructure, payments as allPayments, formatNaira } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GraduationCap, LogOut, Wallet, CreditCard, History, Receipt } from "lucide-react";
import { toast } from "sonner";

const StudentDashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [processingOpen, setProcessingOpen] = useState(false);
  const [customAmount, setCustomAmount] = useState("");
  const [lastPayment, setLastPayment] = useState<{ amount: number; reference: string } | null>(null);

  if (!user) {
    navigate("/");
    return null;
  }

  const fees = feeStructure[user.id] || [];
  const totalFees = fees.reduce((s, f) => s + f.amount, 0);
  const totalPaid = fees.reduce((s, f) => s + f.paid, 0);
  const balance = totalFees - totalPaid;
  const studentPayments = allPayments.filter((p) => p.studentId === user.id);

  const statusColor = (status: string) => {
    if (status === "paid") return "bg-primary/15 text-primary border-primary/30";
    if (status === "partial") return "bg-accent/15 text-accent-foreground border-accent/30";
    return "bg-destructive/10 text-destructive border-destructive/30";
  };

  const handlePay = (amount: number) => {
    setPaymentOpen(false);
    setProcessingOpen(true);
    setTimeout(() => {
      const ref = `PSK-${Date.now().toString(36).toUpperCase()}`;
      setLastPayment({ amount, reference: ref });
      setProcessingOpen(false);
      toast.success("Payment successful!");
    }, 2000);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card no-print">
        <div className="container mx-auto flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">EduLedger<span className="text-primary">NG</span></span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground hidden sm:inline">{user.name}</span>
            <Button variant="ghost" size="sm" onClick={() => { logout(); navigate("/"); }}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6 max-w-4xl">
        {/* Welcome */}
        <div className="bg-primary rounded-xl p-6 text-primary-foreground">
          <h1 className="text-2xl font-bold">Welcome, {user.name.split(" ")[0]}!</h1>
          <p className="text-primary-foreground/80 mt-1">{user.class} &bull; {user.term} &bull; {user.session}</p>
        </div>

        {/* Fee Summary Cards */}
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

        {/* Fee Breakdown */}
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
                {fees.map((fee) => (
                  <TableRow key={fee.id}>
                    <TableCell className="font-medium">{fee.name}</TableCell>
                    <TableCell className="text-right">{formatNaira(fee.amount)}</TableCell>
                    <TableCell className="text-right">{formatNaira(fee.paid)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className={statusColor(fee.status)}>
                        {fee.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Make Payment */}
        {balance > 0 && (
          <Card className="border-primary/20">
            <CardContent className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <p className="font-semibold">Outstanding Balance: {formatNaira(balance)}</p>
                <p className="text-sm text-muted-foreground">Pay in full or enter a custom amount</p>
              </div>
              <Button onClick={() => setPaymentOpen(true)} className="gap-2">
                <CreditCard className="w-4 h-4" /> Make Payment
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Payment History */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><History className="w-5 h-5" /> Payment History</CardTitle>
          </CardHeader>
          <CardContent>
            {studentPayments.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-4">No payments yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {studentPayments.map((p) => (
                    <TableRow key={p.id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigate(`/receipt/${p.id}`)}>
                      <TableCell>{new Date(p.date).toLocaleDateString("en-NG")}</TableCell>
                      <TableCell className="font-mono text-xs">{p.reference}</TableCell>
                      <TableCell className="text-xs">{p.items.join(", ")}</TableCell>
                      <TableCell className="text-right font-medium">{formatNaira(p.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Payment Modal */}
      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make Payment via Paystack</DialogTitle>
            <DialogDescription>Balance: {formatNaira(balance)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Button className="w-full" onClick={() => handlePay(balance)}>Pay Full Balance — {formatNaira(balance)}</Button>
            <div className="relative">
              <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
              <div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">or pay custom amount</span></div>
            </div>
            <div className="flex gap-2">
              <Input type="number" placeholder="Enter amount" value={customAmount} onChange={(e) => setCustomAmount(e.target.value)} />
              <Button variant="outline" disabled={!customAmount || Number(customAmount) <= 0 || Number(customAmount) > balance} onClick={() => handlePay(Number(customAmount))}>Pay</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Processing Modal */}
      <Dialog open={processingOpen}>
        <DialogContent className="text-center">
          <div className="py-8">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="font-semibold">Processing payment via Paystack...</p>
            <p className="text-sm text-muted-foreground">Please wait</p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Success Modal */}
      <Dialog open={!!lastPayment} onOpenChange={() => setLastPayment(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-primary">Payment Successful! 🎉</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p><strong>Amount:</strong> {lastPayment && formatNaira(lastPayment.amount)}</p>
            <p><strong>Reference:</strong> {lastPayment?.reference}</p>
            <p><strong>Method:</strong> Paystack</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLastPayment(null)}>Close</Button>
            <Button onClick={() => { navigate(`/receipt/latest`); setLastPayment(null); }} className="gap-2">
              <Receipt className="w-4 h-4" /> View Receipt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default StudentDashboard;
