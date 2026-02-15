import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { payments, students, feeStructure, formatNaira } from "@/lib/mockData";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, Printer, ArrowLeft, CheckCircle2, AlertCircle, Clock } from "lucide-react";

const ReceiptPage = () => {
  const { paymentId } = useParams();
  const navigate = useNavigate();

  const payment = paymentId === "latest" ? payments[payments.length - 1] : payments.find((p) => p.id === paymentId);

  if (!payment) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">Receipt not found</p>
          <Button variant="link" onClick={() => navigate(-1)}>Go back</Button>
        </div>
      </div>
    );
  }

  const student = students.find((s) => s.id === payment.studentId);
  const fees = feeStructure[payment.studentId] || [];
  const totalFees = fees.reduce((s, f) => s + f.amount, 0);
  const totalPaid = fees.reduce((s, f) => s + f.paid, 0);
  const totalOutstanding = totalFees - totalPaid;

  const paidFees = fees.filter((f) => f.status === "paid");
  const partialFees = fees.filter((f) => f.status === "partial");
  const unpaidFees = fees.filter((f) => f.status === "unpaid");

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-lg mx-auto">
        <div className="no-print mb-4 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(-1)} className="gap-2">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
          <Button size="sm" onClick={() => window.print()} className="gap-2">
            <Printer className="w-4 h-4" /> Print Receipt
          </Button>
        </div>

        <Card className="shadow-lg">
          <CardHeader className="text-center border-b pb-6">
            <div className="flex items-center justify-center gap-2 mb-2">
              <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-primary-foreground" />
              </div>
            </div>
            <h1 className="text-xl font-bold">EduLedger<span className="text-primary">NG</span></h1>
            <p className="text-sm text-muted-foreground">Model Secondary School, Lagos</p>
            <p className="text-xs text-muted-foreground mt-1">PAYMENT RECEIPT</p>
          </CardHeader>
          <CardContent className="pt-6 space-y-4">
            {/* Student Info */}
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <p className="text-muted-foreground">Student Name</p>
              <p className="font-medium text-right">{payment.studentName}</p>
              <p className="text-muted-foreground">School ID</p>
              <p className="font-mono text-right">{payment.studentId}</p>
              <p className="text-muted-foreground">Class</p>
              <p className="text-right">{payment.class}</p>
              {student && (
                <>
                  <p className="text-muted-foreground">Term / Session</p>
                  <p className="text-right">{student.term} — {student.session}</p>
                </>
              )}
            </div>

            <Separator />

            {/* Transaction Info */}
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <p className="text-muted-foreground">Transaction Ref</p>
              <p className="font-mono text-right text-xs">{payment.reference}</p>
              <p className="text-muted-foreground">Date</p>
              <p className="text-right">{new Date(payment.date).toLocaleDateString("en-NG", { year: "numeric", month: "long", day: "numeric" })}</p>
              <p className="text-muted-foreground">Payment Method</p>
              <p className="text-right">{payment.method}</p>
            </div>

            <Separator />

            {/* Items Paid */}
            <div className="text-sm">
              <p className="font-semibold mb-2">Fees Paid in This Transaction</p>
              <div className="space-y-1">
                {payment.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between py-1">
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            {/* Amount Paid */}
            <div className="flex items-center justify-between">
              <p className="text-lg font-bold">Amount Paid</p>
              <p className="text-2xl font-bold text-primary">{formatNaira(payment.amount)}</p>
            </div>

            <Separator />

            {/* Fully Cleared Fees */}
            {paidFees.length > 0 && (
              <div className="text-sm">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                  <p className="font-semibold">Fully Cleared Fees</p>
                </div>
                <div className="space-y-1 pl-6">
                  {paidFees.map((fee) => (
                    <div key={fee.id} className="flex items-center justify-between py-1">
                      <span>{fee.name}</span>
                      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 text-xs">{formatNaira(fee.amount)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Partially Paid Fees */}
            {partialFees.length > 0 && (
              <div className="text-sm">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="w-4 h-4 text-amber-500" />
                  <p className="font-semibold">Partially Paid Fees</p>
                </div>
                <div className="space-y-1 pl-6">
                  {partialFees.map((fee) => (
                    <div key={fee.id} className="flex items-center justify-between py-1">
                      <div>
                        <span>{fee.name}</span>
                        <span className="text-muted-foreground ml-1 text-xs">({formatNaira(fee.paid)} of {formatNaira(fee.amount)})</span>
                      </div>
                      <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/30 text-xs">Bal: {formatNaira(fee.amount - fee.paid)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Outstanding Fees */}
            {unpaidFees.length > 0 && (
              <div className="text-sm">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle className="w-4 h-4 text-destructive" />
                  <p className="font-semibold">Outstanding Fees (Unpaid)</p>
                </div>
                <div className="space-y-1 pl-6">
                  {unpaidFees.map((fee) => (
                    <div key={fee.id} className="flex items-center justify-between py-1">
                      <span>{fee.name}</span>
                      <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 text-xs">{formatNaira(fee.amount)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Separator />

            {/* Account Summary */}
            <div className="text-sm rounded-lg bg-muted/50 p-4 space-y-2">
              <p className="font-semibold text-center mb-3">Account Summary</p>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Fees</span>
                <span className="font-medium">{formatNaira(totalFees)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Paid</span>
                <span className="font-medium text-primary">{formatNaira(totalPaid)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-bold">
                <span>Total Outstanding</span>
                <span className={totalOutstanding > 0 ? "text-destructive" : "text-primary"}>{formatNaira(totalOutstanding)}</span>
              </div>
            </div>

            <div className="text-center text-xs text-muted-foreground pt-4 border-t">
              <p>This is a computer-generated receipt and is valid without a signature.</p>
              <p className="mt-1">EduLedgerNG &copy; {new Date().getFullYear()}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default ReceiptPage;
