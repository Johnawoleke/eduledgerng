import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { payments, students, formatNaira } from "@/lib/mockData";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { GraduationCap, Printer, ArrowLeft } from "lucide-react";

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

            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <p className="text-muted-foreground">Transaction Ref</p>
              <p className="font-mono text-right text-xs">{payment.reference}</p>
              <p className="text-muted-foreground">Date</p>
              <p className="text-right">{new Date(payment.date).toLocaleDateString("en-NG", { year: "numeric", month: "long", day: "numeric" })}</p>
              <p className="text-muted-foreground">Payment Method</p>
              <p className="text-right">{payment.method}</p>
            </div>

            <Separator />

            <div className="text-sm">
              <p className="text-muted-foreground mb-2">Items Paid</p>
              <ul className="list-disc list-inside space-y-1">
                {payment.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <p className="text-lg font-bold">Amount Paid</p>
              <p className="text-2xl font-bold text-primary">{formatNaira(payment.amount)}</p>
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
