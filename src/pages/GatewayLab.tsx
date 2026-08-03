// Internal gateway-cost lab. Not linked from the marketing site — the public
// /calculator stays a simple "what does my school receive" page for owners.
// This one exists to decide which gateway(s) to integrate, so every number in
// the model is a control: rate cards, channel mix, who absorbs the fee, and the
// routing rule itself.
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
  DEFAULT_PROVIDERS, CHANNELS, runStrategy,
  type Provider, type Strategy, type Channel,
} from "@/lib/gatewayFees";

const naira = (kobo: number, dp = 0): string =>
  new Intl.NumberFormat("en-NG", {
    style: "currency", currency: "NGN", maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(kobo / 100);

const clone = (ps: Provider[]): Provider[] => JSON.parse(JSON.stringify(ps));
const num = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);
const SWEEP = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000, 400_000];

/** A labelled slider — the primary control type in this tool. */
const Knob: React.FC<{
  label: string; value: number; onChange: (n: number) => void;
  min?: number; max?: number; step?: number; suffix?: string; hint?: string;
}> = ({ label, value, onChange, min = 0, max = 100, step = 1, suffix = "%", hint }) => (
  <div className="space-y-1">
    <div className="flex items-baseline justify-between gap-2">
      <Label className="text-xs">{label}</Label>
      <span className="text-xs font-semibold tabular-nums">{value}{suffix}</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-primary h-6" />
    {hint && <p className="text-[11px] text-muted-foreground leading-tight">{hint}</p>}
  </div>
);

const GatewayLab = () => {
  const navigate = useNavigate();

  // --- scenario knobs -------------------------------------------------------
  const [feeInput, setFeeInput] = useState("100000");
  const [studentsInput, setStudentsInput] = useState("500");
  const [platformPct, setPlatformPct] = useState(1);
  const [parentSharePct, setParentSharePct] = useState(100);
  const [mixCard, setMixCard] = useState(40);
  const [mixTransfer, setMixTransfer] = useState(55);
  const [mixUssd, setMixUssd] = useState(5);

  // --- routing knobs --------------------------------------------------------
  const [providers, setProviders] = useState<Provider[]>(() => clone(DEFAULT_PROVIDERS));
  const [baselineId, setBaselineId] = useState("paystack");
  const [splitBy, setSplitBy] = useState<Record<Channel, string>>({
    card: "paystack-edu", transfer: "paystack-dva", ussd: "paystack-edu",
  });
  const [thresholdInput, setThresholdInput] = useState("30000");
  const [belowId, setBelowId] = useState("paystack-dva");
  const [aboveId, setAboveId] = useState("paystack-edu");

  const inputs = useMemo(() => ({
    baseKobo: Math.round(Math.max(num(feeInput), 0) * 100),
    students: Math.max(Math.floor(num(studentsInput)), 0),
    mix: { card: mixCard, transfer: mixTransfer, ussd: mixUssd } as Record<Channel, number>,
    platformRate: platformPct / 100,
    parentShare: parentSharePct / 100,
    providers,
  }), [feeInput, studentsInput, mixCard, mixTransfer, mixUssd, platformPct, parentSharePct, providers]);

  const strategies: Strategy[] = useMemo(() => [
    ...providers.map((p) => ({ kind: "single" as const, providerId: p.id })),
    { kind: "split", byChannel: splitBy },
    { kind: "threshold", thresholdKobo: Math.round(num(thresholdInput) * 100), belowId, aboveId },
    { kind: "cheapest" },
  ], [providers, splitBy, thresholdInput, belowId, aboveId]);

  const results = useMemo(
    () => strategies.map((s) => ({ key: JSON.stringify(s), ...runStrategy(s, inputs) })),
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

  // Cheapest routing across a range of fee sizes — shows where the crossovers are.
  const sweep = useMemo(() => SWEEP.map((fee) => {
    const at = { ...inputs, baseKobo: fee * 100 };
    return {
      fee,
      rows: strategies.map((s) => runStrategy(s, at)),
      base: runStrategy({ kind: "single", providerId: baselineId }, at),
    };
  }), [strategies, inputs, baselineId]);

  const setRate = (pid: string, ch: Channel, field: "percent" | "flat" | "cap", raw: string) => {
    setProviders((prev) => prev.map((p) => {
      if (p.id !== pid) return p;
      const next = clone([p])[0];
      const n = num(raw);
      if (field === "percent") next.channels[ch].percent = n / 100;
      if (field === "flat") next.channels[ch].flat = Math.max(n, 0) * 100;
      if (field === "cap") next.channels[ch].cap = raw.trim() === "" ? undefined : Math.max(n, 0) * 100;
      return next;
    }));
  };
  const toggleSupport = (pid: string, ch: Channel) => {
    setProviders((prev) => prev.map((p) => {
      if (p.id !== pid) return p;
      const next = clone([p])[0];
      next.channels[ch].unsupported = !next.channels[ch].unsupported;
      return next;
    }));
  };

  const mixTotal = mixCard + mixTransfer + mixUssd;

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

      <main className="container mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold mb-2">Gateway cost lab</h1>
          <p className="text-muted-foreground max-w-3xl">
            Every number here is a control. Change the rate cards, the channel mix, who absorbs the
            gateway fee, and the routing rule — the comparison and the fee-size sweep update live.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6 items-start">
          {/* ------------------------------ CONTROLS ------------------------ */}
          <div className="space-y-4 lg:sticky lg:top-20">
            <Card>
              <CardContent className="pt-5 space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scenario</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="fee" className="text-xs">Fee (₦)</Label>
                    <Input id="fee" className="h-9" inputMode="numeric" value={feeInput}
                      onChange={(e) => setFeeInput(e.target.value.replace(/[^0-9.]/g, ""))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="students" className="text-xs">Payments</Label>
                    <Input id="students" className="h-9" inputMode="numeric" value={studentsInput}
                      onChange={(e) => setStudentsInput(e.target.value.replace(/[^0-9]/g, ""))} />
                  </div>
                </div>
                <Knob label="Platform fee" value={platformPct} onChange={setPlatformPct}
                  min={0} max={10} step={0.25} hint="Our cut, added on top of the school's fee." />
                <Knob label="Gateway fee borne by parent" value={parentSharePct} onChange={setParentSharePct}
                  min={0} max={100} step={5}
                  hint={parentSharePct === 100
                    ? "Today's model: the parent covers all of it."
                    : parentSharePct === 0
                      ? "The school absorbs the whole gateway fee out of its own fee."
                      : `The school absorbs the other ${100 - parentSharePct}%.`} />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5 space-y-3">
                <div className="flex items-baseline justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel mix</p>
                  <span className={`text-[11px] ${mixTotal === 100 ? "text-muted-foreground" : "text-amber-600"}`}>
                    {mixTotal === 100 ? "100%" : `${mixTotal}% — normalised`}
                  </span>
                </div>
                <Knob label="Card" value={mixCard} onChange={setMixCard} />
                <Knob label="Bank transfer" value={mixTransfer} onChange={setMixTransfer} />
                <Knob label="USSD" value={mixUssd} onChange={setMixUssd} />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Routing rules</p>
                <div className="space-y-2">
                  <Label className="text-xs">Custom split — per channel</Label>
                  {CHANNELS.map((c) => (
                    <div key={c.id} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground w-20 shrink-0">{c.label}</span>
                      <Select value={splitBy[c.id]} onValueChange={(v) => setSplitBy((m) => ({ ...m, [c.id]: v }))}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                <div className="space-y-2 border-t pt-3">
                  <Label className="text-xs">Split by fee size</Label>
                  <Input className="h-8 text-xs" inputMode="numeric" value={thresholdInput}
                    onChange={(e) => setThresholdInput(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="threshold ₦" />
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground w-20 shrink-0">below</span>
                    <Select value={belowId} onValueChange={setBelowId}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground w-20 shrink-0">at/above</span>
                    <Select value={aboveId} onValueChange={setAboveId}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1 border-t pt-3">
                  <Label className="text-xs">Compare against</Label>
                  <Select value={baselineId} onValueChange={setBaselineId}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ------------------------------ RESULTS ------------------------- */}
          <div className="space-y-6 min-w-0">
            {inputs.students > 0 && best.blendedGatewayKobo < baseline.blendedGatewayKobo && (
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="pt-5 flex items-start gap-3">
                  <TrendingDown className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">
                      {best.label} — {naira(baseline.blendedGatewayKobo - best.blendedGatewayKobo)} less per payment
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {naira(baseline.totalGatewayKobo - best.totalGatewayKobo)} less across{" "}
                      {inputs.students.toLocaleString()} payments than {baseline.label}.
                      {parentSharePct < 100 && (
                        <> At {parentSharePct}% parent-borne, the school nets{" "}
                        {naira(best.blendedSchoolReceivesKobo)} per payment.</>
                      )}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="overflow-hidden">
              <div className="px-5 py-3 border-b bg-muted/40">
                <h2 className="font-semibold text-sm">At ₦{Math.max(num(feeInput), 0).toLocaleString()}</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-muted-foreground text-xs">
                    <tr>
                      <th className="text-left font-medium px-4 py-2">Routing</th>
                      {CHANNELS.map((c) => <th key={c.id} className="text-right font-medium px-3 py-2">{c.label}</th>)}
                      <th className="text-right font-medium px-3 py-2">Blended</th>
                      <th className="text-right font-medium px-3 py-2">Parent pays</th>
                      <th className="text-right font-medium px-3 py-2">School nets</th>
                      <th className="text-right font-medium px-4 py-2">vs baseline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => {
                      const delta = r.blendedGatewayKobo - baseline.blendedGatewayKobo;
                      const isBest = r.blendedGatewayKobo === best.blendedGatewayKobo;
                      return (
                        <tr key={r.key} className={`border-t ${isBest ? "bg-primary/5" : ""}`}>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{r.label}</span>
                              {isBest && <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 py-0">Best</Badge>}
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">{r.detail}</p>
                          </td>
                          {CHANNELS.map((c) => (
                            <td key={c.id} className="px-3 py-2.5 text-right tabular-nums">
                              {r.perChannel[c.id].unsupported
                                ? <span className="text-muted-foreground/50">n/a</span>
                                : naira(r.perChannel[c.id].gatewayFeeKobo)}
                            </td>
                          ))}
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{naira(r.blendedGatewayKobo)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{naira(r.blendedParentKobo)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{naira(r.blendedSchoolReceivesKobo)}</td>
                          <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${
                            delta < -0.5 ? "text-primary" : delta > 0.5 ? "text-destructive" : "text-muted-foreground"
                          }`}>
                            {Math.abs(delta) < 0.5 ? "—" : `${delta < 0 ? "−" : "+"}${naira(Math.abs(delta))}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Sweep — where the crossovers actually are */}
            <Card className="overflow-hidden">
              <div className="px-5 py-3 border-b bg-muted/40">
                <h2 className="font-semibold text-sm">Blended gateway fee across fee sizes</h2>
                <p className="text-[11px] text-muted-foreground">
                  Same mix and rules, swept over the fee amount. This is where the crossovers show up.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-muted-foreground text-xs">
                    <tr>
                      <th className="text-left font-medium px-4 py-2">Fee</th>
                      {results.map((r) => (
                        <th key={r.key} className="text-right font-medium px-3 py-2 whitespace-nowrap">{r.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sweep.map((row) => {
                      const min = Math.min(...row.rows.map((r) => r.blendedGatewayKobo));
                      return (
                        <tr key={row.fee} className="border-t">
                          <td className="px-4 py-2 font-medium tabular-nums">{naira(row.fee * 100)}</td>
                          {row.rows.map((r, i) => (
                            <td key={i} className={`px-3 py-2 text-right tabular-nums ${
                              r.blendedGatewayKobo === min ? "font-semibold text-primary" : "text-muted-foreground"
                            }`}>
                              {naira(r.blendedGatewayKobo)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Rate cards */}
            <Card>
              <div className="px-5 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="font-semibold text-sm">Rate cards</h2>
                  <p className="text-[11px] text-muted-foreground">
                    Published rates as of 3 Aug 2026. Edit any field to model a negotiated deal.
                  </p>
                </div>
                <Button variant="outline" size="sm" className="gap-2"
                  onClick={() => setProviders(clone(DEFAULT_PROVIDERS))}>
                  <RotateCcw className="w-3.5 h-3.5" /> Reset
                </Button>
              </div>
              <CardContent className="pt-5 grid grid-cols-1 xl:grid-cols-2 gap-5">
                {providers.map((p) => (
                  <div key={p.id} className="rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h3 className="font-semibold text-sm">{p.name}</h3>
                      {p.negotiated && <Badge variant="secondary" className="shrink-0 text-[10px]">Quote-based</Badge>}
                    </div>
                    <p className="text-[11px] text-muted-foreground mb-3">{p.note}</p>
                    {CHANNELS.map((ch) => {
                      const c = p.channels[ch.id];
                      return (
                        <div key={ch.id} className="mb-2.5 last:mb-0">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[11px] font-medium">{ch.label}</p>
                            <button type="button" onClick={() => toggleSupport(p.id, ch.id)}
                              className="text-[10px] text-muted-foreground hover:text-foreground underline">
                              {c.unsupported ? "not offered — enable" : "disable"}
                            </button>
                          </div>
                          <div className={`grid grid-cols-3 gap-2 ${c.unsupported ? "opacity-40" : ""}`}>
                            <Input className="h-7 text-xs" inputMode="decimal" placeholder="%"
                              value={String(+(c.percent * 100).toFixed(4))}
                              onChange={(e) => setRate(p.id, ch.id, "percent", e.target.value.replace(/[^0-9.]/g, ""))} />
                            <Input className="h-7 text-xs" inputMode="numeric" placeholder="flat ₦"
                              value={String(c.flat / 100)}
                              onChange={(e) => setRate(p.id, ch.id, "flat", e.target.value.replace(/[^0-9.]/g, ""))} />
                            <Input className="h-7 text-xs" inputMode="numeric" placeholder="cap ₦"
                              value={c.cap == null ? "" : String(c.cap / 100)}
                              onChange={(e) => setRate(p.id, ch.id, "cap", e.target.value.replace(/[^0-9.]/g, ""))} />
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-[10px] text-muted-foreground mt-2">rate % · flat ₦ · cap ₦ (blank = uncapped)</p>
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="rounded-lg border p-4 flex items-start gap-3 text-xs text-muted-foreground">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p><strong className="text-foreground">Paystack for Education</strong> — 0.7% capped ₦1,500 on cards, flat ₦300 on every other method. Must be applied for; it is not the rate a new account gets.</p>
                <p><strong className="text-foreground">Kora</strong> publishes 1.5% capped ₦2,000 in third-party comparisons but states its own pricing is custom. Treat the default as a negotiating start, not a quote.</p>
                <p>Confirm both directly before integrating — this model is only as good as the numbers in it.</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default GatewayLab;
