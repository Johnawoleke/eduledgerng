// Internal gateway-cost lab. Not linked from the marketing site — the public
// /calculator stays a simple "what does my school receive" page for owners.
// This one is for deciding which gateway(s) to integrate, so it exposes the
// rate cards as editable inputs rather than presenting them as fact.
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, RotateCcw, TrendingDown, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_PROVIDERS, CHANNELS, runStrategy, type Provider, type Strategy, type Channel,
} from "@/lib/gatewayFees";

const naira = (kobo: number, dp = 0): string =>
  new Intl.NumberFormat("en-NG", {
    style: "currency", currency: "NGN", maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(kobo / 100);

const clone = (ps: Provider[]): Provider[] => JSON.parse(JSON.stringify(ps));

const GatewayLab = () => {
  const navigate = useNavigate();
  const [feeInput, setFeeInput] = useState("100000");
  const [studentsInput, setStudentsInput] = useState("500");
  const [cardSharePct, setCardSharePct] = useState(40);
  const [platformPct, setPlatformPct] = useState("1");
  const [providers, setProviders] = useState<Provider[]>(() => clone(DEFAULT_PROVIDERS));
  const [baselineId, setBaselineId] = useState("paystack");
  const [splitCard, setSplitCard] = useState("paystack-edu");
  const [splitTransfer, setSplitTransfer] = useState("paystack-dva");

  const inputs = useMemo(() => ({
    baseKobo: Math.round(Math.max(Number(feeInput) || 0, 0) * 100),
    students: Math.max(Math.floor(Number(studentsInput) || 0), 0),
    cardShare: cardSharePct / 100,
    platformRate: Math.max(Number(platformPct) || 0, 0) / 100,
    providers,
  }), [feeInput, studentsInput, cardSharePct, platformPct, providers]);

  const strategies: Strategy[] = useMemo(() => [
    ...providers.map((p) => ({ kind: "single" as const, providerId: p.id })),
    { kind: "split", cardProviderId: splitCard, transferProviderId: splitTransfer },
    { kind: "cheapest" },
  ], [providers, splitCard, splitTransfer]);

  const results = useMemo(
    () => strategies.map((s) => ({ strategy: s, ...runStrategy(s, inputs) })),
    [strategies, inputs]
  );

  const baseline = useMemo(
    () => runStrategy({ kind: "single", providerId: baselineId }, inputs),
    [baselineId, inputs]
  );

  const best = useMemo(
    () => results.reduce((a, b) => (b.blendedGatewayKobo < a.blendedGatewayKobo ? b : a)),
    [results]
  );

  const setRate = (pid: string, ch: Channel, field: "percent" | "flat" | "cap", raw: string) => {
    setProviders((prev) => prev.map((p) => {
      if (p.id !== pid) return p;
      const next = clone([p])[0];
      const n = Number(raw);
      if (field === "percent") next.channels[ch].percent = (Number.isFinite(n) ? n : 0) / 100;
      if (field === "flat") next.channels[ch].flat = Math.max(Number.isFinite(n) ? n : 0, 0) * 100;
      if (field === "cap") next.channels[ch].cap = raw.trim() === "" ? undefined : Math.max(n, 0) * 100;
      return next;
    }));
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-card/90 backdrop-blur">
        <div className="container mx-auto px-4 flex items-center justify-between h-16">
          <button onClick={() => navigate("/")} className="flex items-center gap-2">
            <img src="/logo.jpeg" alt="" className="w-8 h-8 rounded-lg object-contain" />
            <span className="font-bold text-lg text-primary">
              EduLedger<span className="text-[#F5C518]">NG</span>
            </span>
          </button>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex">Internal</Badge>
            <Button variant="ghost" className="gap-2" onClick={() => navigate("/")}>
              <ArrowLeft className="w-4 h-4" /> <span className="hidden sm:inline">Home</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-6xl px-4 py-8 space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold mb-2">Gateway cost lab</h1>
          <p className="text-muted-foreground max-w-3xl">
            Model what parents actually pay under each gateway, standalone or combined. The school
            always receives the exact fee and the platform always keeps its cut, so the only figure
            that moves is the gateway's take, which the parent bears.
          </p>
        </div>

        {/* Scenario */}
        <Card>
          <CardContent className="pt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="fee">Fee per student (₦)</Label>
              <Input id="fee" inputMode="numeric" value={feeInput}
                onChange={(e) => setFeeInput(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="students">Payments modelled</Label>
              <Input id="students" inputMode="numeric" value={studentsInput}
                onChange={(e) => setStudentsInput(e.target.value.replace(/[^0-9]/g, ""))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="platform">Platform fee (%)</Label>
              <Input id="platform" inputMode="decimal" value={platformPct}
                onChange={(e) => setPlatformPct(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mix">Paid by card: {cardSharePct}%</Label>
              <input id="mix" type="range" min={0} max={100} step={5} value={cardSharePct}
                onChange={(e) => setCardSharePct(Number(e.target.value))}
                className="w-full accent-primary h-9" />
              <p className="text-xs text-muted-foreground">
                The other {100 - cardSharePct}% pay by transfer. This mix drives everything.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Comparison */}
        <Card className="overflow-hidden">
          <div className="px-6 py-4 border-b bg-muted/40 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold">Cost per payment</h2>
              <p className="text-xs text-muted-foreground">Compared against baseline</p>
            </div>
            <Select value={baselineId} onValueChange={setBaselineId}>
              <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>Baseline: {p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Routing</th>
                  <th className="text-right font-medium px-4 py-2.5">Card</th>
                  <th className="text-right font-medium px-4 py-2.5">Transfer</th>
                  <th className="text-right font-medium px-4 py-2.5">Blended fee</th>
                  <th className="text-right font-medium px-4 py-2.5">Parent pays</th>
                  <th className="text-right font-medium px-4 py-2.5">Total fees</th>
                  <th className="text-right font-medium px-4 py-2.5">vs baseline</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const delta = r.blendedGatewayKobo - baseline.blendedGatewayKobo;
                  const totalDelta = r.totalGatewayKobo - baseline.totalGatewayKobo;
                  const isBest = r.blendedGatewayKobo === best.blendedGatewayKobo;
                  return (
                    <tr key={i} className={`border-t ${isBest ? "bg-primary/5" : ""}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{r.label}</span>
                          {isBest && <Badge className="bg-primary text-primary-foreground">Cheapest</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{r.detail}</p>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{naira(r.perChannel.card.gatewayFeeKobo)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{naira(r.perChannel.transfer.gatewayFeeKobo)}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-semibold">{naira(r.blendedGatewayKobo)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{naira(r.blendedParentKobo)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{naira(r.totalGatewayKobo)}</td>
                      <td className={`px-4 py-3 text-right tabular-nums font-medium ${
                        delta < -0.5 ? "text-primary" : delta > 0.5 ? "text-destructive" : "text-muted-foreground"
                      }`}>
                        {Math.abs(delta) < 0.5 ? "—" : (
                          <>
                            {delta < 0 ? "−" : "+"}{naira(Math.abs(delta))}
                            <span className="block text-xs font-normal opacity-80">
                              {delta < 0 ? "saves " : "costs "}{naira(Math.abs(totalDelta))} total
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-3 border-t bg-muted/20 flex items-center gap-4 flex-wrap text-xs">
            <span className="text-muted-foreground">Custom split:</span>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">cards</span>
              <Select value={splitCard} onValueChange={setSplitCard}>
                <SelectTrigger className="h-8 w-[190px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">transfers</span>
              <Select value={splitTransfer} onValueChange={setSplitTransfer}>
                <SelectTrigger className="h-8 w-[190px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </Card>

        {/* Headline */}
        {inputs.students > 0 && best.blendedGatewayKobo < baseline.blendedGatewayKobo && (
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-6 flex items-start gap-3">
              <TrendingDown className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">
                  {best.label} saves parents{" "}
                  {naira(baseline.blendedGatewayKobo - best.blendedGatewayKobo)} per payment
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Across {inputs.students.toLocaleString()} payments that is{" "}
                  <strong className="text-foreground">
                    {naira(baseline.totalGatewayKobo - best.totalGatewayKobo)}
                  </strong>{" "}
                  less taken in gateway fees than {baseline.label}. Your school still receives{" "}
                  {naira(best.totalSchoolKobo)} and the platform still keeps{" "}
                  {naira(best.totalPlatformKobo)} either way.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Editable rate cards */}
        <Card>
          <div className="px-6 py-4 border-b flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold">Rate cards</h2>
              <p className="text-xs text-muted-foreground">
                Published rates as of 3 Aug 2026. Edit any of them to model a negotiated deal.
              </p>
            </div>
            <Button variant="outline" size="sm" className="gap-2"
              onClick={() => setProviders(clone(DEFAULT_PROVIDERS))}>
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </Button>
          </div>
          <CardContent className="pt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {providers.map((p) => (
              <div key={p.id} className="rounded-lg border p-4">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 className="font-semibold">{p.name}</h3>
                  {p.negotiated && <Badge variant="secondary" className="shrink-0">Quote-based</Badge>}
                </div>
                <p className="text-xs text-muted-foreground mb-4">{p.note}</p>
                {CHANNELS.map((ch) => (
                  <div key={ch.id} className="mb-3 last:mb-0">
                    <p className="text-xs font-medium mb-1.5">{ch.label}</p>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <Label className="text-[11px] text-muted-foreground">Rate %</Label>
                        <Input className="h-8" inputMode="decimal"
                          value={String(+(p.channels[ch.id].percent * 100).toFixed(4))}
                          onChange={(e) => setRate(p.id, ch.id, "percent", e.target.value.replace(/[^0-9.]/g, ""))} />
                      </div>
                      <div>
                        <Label className="text-[11px] text-muted-foreground">Flat ₦</Label>
                        <Input className="h-8" inputMode="numeric"
                          value={String(p.channels[ch.id].flat / 100)}
                          onChange={(e) => setRate(p.id, ch.id, "flat", e.target.value.replace(/[^0-9.]/g, ""))} />
                      </div>
                      <div>
                        <Label className="text-[11px] text-muted-foreground">Cap ₦</Label>
                        <Input className="h-8" inputMode="numeric" placeholder="none"
                          value={p.channels[ch.id].cap == null ? "" : String(p.channels[ch.id].cap! / 100)}
                          onChange={(e) => setRate(p.id, ch.id, "cap", e.target.value.replace(/[^0-9.]/g, ""))} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="rounded-lg border p-5 flex items-start gap-3 text-sm text-muted-foreground">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p><strong className="text-foreground">Paystack for Education</strong> is 0.7% capped ₦1,500 on cards and a flat ₦300 on every other method. It has to be applied for — it is not the rate a new account gets.</p>
            <p><strong className="text-foreground">Kora</strong> publishes 1.5% capped ₦2,000 in third-party comparisons but states its own pricing is custom, so treat the default here as a starting point for negotiation, not a quote.</p>
            <p>Rates verified 3 Aug 2026. Confirm both directly before integrating — this model is only as good as the numbers in it.</p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default GatewayLab;
