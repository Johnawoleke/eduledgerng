import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { computeCheckoutKobo, PLATFORM_FEE_RATE } from "@/lib/paystackFees";

const naira = (kobo: number): string =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
  }).format(kobo / 100);

const Calculator = () => {
  const navigate = useNavigate();
  const [feeInput, setFeeInput] = useState("50000");
  const [studentsInput, setStudentsInput] = useState("100");

  const feeNGN = Math.max(Number(feeInput) || 0, 0);
  const students = Math.max(Math.floor(Number(studentsInput) || 0), 0);

  const breakdown = useMemo(() => computeCheckoutKobo(feeNGN), [feeNGN]);
  const { baseKobo, platformFeeKobo, processingFeeKobo, totalKobo } = breakdown;

  const platformPct = (PLATFORM_FEE_RATE * 100).toFixed(0);

  return (
    <div className="min-h-screen bg-background">
      {/* Top navigation: mirrors the landing page chrome */}
      <header className="sticky top-0 z-50 border-b bg-card/90 backdrop-blur">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <button
              onClick={() => navigate("/")}
              className="flex items-center gap-2"
              aria-label="EduLedgerNG home"
            >
              <img src="/logo.jpeg" alt="" className="w-8 h-8 rounded-lg object-contain" />
              <span className="font-bold text-lg text-primary">
                EduLedger<span className="text-[#F5C518]">NG</span>
              </span>
            </button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" className="gap-2" onClick={() => navigate("/")}>
                <ArrowLeft className="w-4 h-4" /> <span className="hidden sm:inline">Home</span>
              </Button>
              <Button onClick={() => navigate("/register")}>Register</Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-10 sm:py-14">
        {/* Intro */}
        <div className="text-center mb-8">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary mb-2">
            Fee Calculator
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold mb-3 text-balance">
            See exactly what everyone pays and receives
          </h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Your school receives the <strong>exact fee</strong> you set. The parent covers a small
            gateway fee at checkout, and EduLedgerNG keeps a flat {platformPct}%. Nothing is
            deducted from your school.
          </p>
        </div>

        {/* Inputs */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="fee">Fee amount (₦)</Label>
                <Input
                  id="fee"
                  inputMode="numeric"
                  value={feeInput}
                  onChange={(e) => setFeeInput(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="e.g. 50000"
                />
                <p className="text-xs text-muted-foreground">The fee a parent pays for one item.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="students">Number of students (optional)</Label>
                <Input
                  id="students"
                  inputMode="numeric"
                  value={studentsInput}
                  onChange={(e) => setStudentsInput(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="e.g. 100"
                />
                <p className="text-xs text-muted-foreground">To project totals across your school.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Per-payment breakdown */}
        <Card className="mb-6 overflow-hidden">
          <div className="bg-primary/5 px-6 py-4 border-b">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-sm font-medium text-muted-foreground">Parent pays at checkout</span>
              <span className="text-2xl font-bold text-primary">{naira(totalKobo)}</span>
            </div>
          </div>
          <CardContent className="pt-5 space-y-3">
            <Row label="Fee your school set" value={naira(baseKobo)} muted />
            <Row label={`Platform fee (${platformPct}%)`} value={`+ ${naira(platformFeeKobo)}`} muted />
            <Row label="Paystack gateway fee" value={`+ ${naira(processingFeeKobo)}`} muted />
            <div className="border-t pt-3 mt-1 space-y-3">
              <Row
                label="Your school receives"
                value={naira(baseKobo)}
                highlight="school"
                hint="Settled to your bank: the exact fee, nothing deducted"
              />
              <Row
                label="EduLedgerNG keeps"
                value={naira(platformFeeKobo)}
                highlight="platform"
                hint={`Flat ${platformPct}% of the fee`}
              />
            </div>
          </CardContent>
        </Card>

        {/* Aggregate projection */}
        {students > 0 && feeNGN > 0 && (
          <Card className="mb-8 bg-muted/40">
            <CardContent className="pt-6">
              <p className="text-sm font-semibold mb-3">
                If {students.toLocaleString()} student{students === 1 ? "" : "s"} pay this fee
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Stat
                  label="Your school collects"
                  value={naira(baseKobo * students)}
                />
                <Stat
                  label="Parents pay in total"
                  value={naira(totalKobo * students)}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* How it works */}
        <div className="rounded-lg border p-6">
          <h2 className="font-semibold mb-3">How the model works</h2>
          <ul className="space-y-2.5 text-sm text-muted-foreground">
            {[
              "You set your fees. Your school receives the exact amount, and we never deduct from it.",
              `EduLedgerNG earns a flat ${platformPct}% per payment, added on top at checkout.`,
              "Paystack's gateway fee (1.5% + ₦100, waived under ₦2,500, capped at ₦2,000) is also added on top, so the parent covers it.",
              "No setup fee. No subscription. You only ever pay for what parents actually pay.",
            ].map((point) => (
              <li key={point} className="flex items-start gap-2">
                <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6">
            <Button className="gap-2" onClick={() => navigate("/register")}>
              Get Started for Free <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
};

// A label/value line in the breakdown.
const Row: React.FC<{
  label: string;
  value: string;
  muted?: boolean;
  highlight?: "school" | "platform";
  hint?: string;
}> = ({ label, value, muted, highlight, hint }) => (
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <span
        className={
          highlight === "school"
            ? "font-semibold text-primary"
            : highlight === "platform"
              ? "font-semibold"
              : "text-muted-foreground"
        }
      >
        {label}
      </span>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
    <span
      className={`shrink-0 tabular-nums ${muted ? "text-muted-foreground" : "font-semibold"} ${
        highlight === "school" ? "text-primary" : ""
      }`}
    >
      {value}
    </span>
  </div>
);

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md bg-background border px-4 py-3">
    <p className="text-xs text-muted-foreground mb-1">{label}</p>
    <p className="text-lg font-bold tabular-nums">{value}</p>
  </div>
);

export default Calculator;
