// Internal gateway-cost lab. Not linked from the marketing site — the public
// /calculator stays the simple school-facing page.
//
// Design intent: every number on this page states what it means in plain words.
// The first version was a dense grid of currency with headers like "Blended"
// and "vs baseline", which is unreadable unless you already know the model. So:
// a plain-English scenario sentence at the top, one clear answer, then options
// as cards with a money-flow bar, and all the raw detail behind disclosures.
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, RotateCcw, Check, ChevronDown, Info, Wallet, Building2, Landmark,
} from "lucide-react";
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
  type Provider, type Strategy, type Channel, type StrategyResult,
} from "@/lib/gatewayFees";

const naira = (kobo: number, dp = 0): string =>
  new Intl.NumberFormat("en-NG", {
    style: "currency", currency: "NGN", maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(kobo / 100);

const clone = (ps: Provider[]): Provider[] => JSON.parse(JSON.stringify(ps));
const num = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);
const SWEEP = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000, 400_000];

/** An inline number that reads as part of a sentence. */
const InlineNum: React.FC<{
  value: string; onChange: (v: string) => void; width?: string; prefix?: string; suffix?: string;
}> = ({ value, onChange, width = "w-24", prefix, suffix }) => (
  <span className="inline-flex items-baseline">
    {prefix && <span className="text-muted-foreground">{prefix}</span>}
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
      inputMode="numeric"
      className={`${width} mx-1 px-2 py-0.5 rounded border-b-2 border-primary/40 bg-primary/5
        font-semibold text-foreground text-center focus:outline-none focus:border-primary
        focus:bg-primary/10 transition-colors`}
    />
    {suffix && <span className="text-muted-foreground">{suffix}</span>}
  </span>
);

/** A slider that always shows what its current value means. */
const Slider: React.FC<{
  label: string; value: number; onChange: (n: number) => void;
  min?: number; max?: number; step?: number; format?: (n: number) => string; meaning: string;
}> = ({ label, value, onChange, min = 0, max = 100, step = 1, format, meaning }) => (
  <div>
    <div className="flex items-baseline justify-between gap-3 mb-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      <span className="text-sm font-bold tabular-nums text-primary">
        {format ? format(value) : `${value}%`}
      </span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-primary" />
    <p className="text-xs text-muted-foreground mt-1.5 leading-snug">{meaning}</p>
  </div>
);

/**
 * The gateway's charge, drawn relative to the most expensive option.
 *
 * A "where does the money go" bar was the obvious choice here and it was
 * useless: the school's fee is ~98% of every payment, so all the bars looked
 * identical and the one quantity being compared was an invisible sliver. This
 * scales to the worst option instead, so a charge of ₦465 against ₦1,640 reads
 * as roughly a quarter of the bar — the difference you're actually choosing on.
 */
const FeeBar: React.FC<{ kobo: number; maxKobo: number; best: boolean }> = ({
  kobo, maxKobo, best,
}) => (
  <div className="flex items-center gap-3">
    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${best ? "bg-primary" : "bg-muted-foreground/40"}`}
        style={{ width: `${maxKobo > 0 ? Math.max((kobo / maxKobo) * 100, 1.5) : 0}%` }}
      />
    </div>
    <span className={`text-sm font-bold tabular-nums shrink-0 w-20 text-right ${best ? "text-primary" : ""}`}>
      {naira(kobo)}
    </span>
  </div>
);

/** Where one payment's money ends up, as a plain line of figures. */
const MoneySplit: React.FC<{ r: StrategyResult }> = ({ r }) => (
  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
    {[
      { kobo: r.blendedSchoolReceivesKobo, cls: "bg-primary", label: "School gets" },
      { kobo: r.blendedPlatformKobo, cls: "bg-[#F5C518]", label: "We get" },
      { kobo: r.blendedGatewayKobo, cls: "bg-muted-foreground/50", label: "Gateway takes" },
    ].map((p) => (
      <span key={p.label} className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${p.cls}`} />
        <span className="text-muted-foreground">{p.label}</span>
        <span className="font-semibold tabular-nums">{naira(p.kobo)}</span>
      </span>
    ))}
  </div>
);

/** A collapsible section — detail is available but never in the way. */
const Disclose: React.FC<{ title: string; hint: string; children: React.ReactNode }> = ({
  title, hint, children,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/40 transition-colors">
        <div>
          <h2 className="font-semibold text-sm">{title}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
        </div>
        <ChevronDown className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="border-t">{children}</div>}
    </Card>
  );
};

const GatewayLab = () => {
  const navigate = useNavigate();

  const [feeInput, setFeeInput] = useState("100000");
  const [studentsInput, setStudentsInput] = useState("500");
  const [platformPct, setPlatformPct] = useState(1);
  const [parentSharePct, setParentSharePct] = useState(100);
  const [mixCard, setMixCard] = useState(40);
  const [mixTransfer, setMixTransfer] = useState(55);
  const [mixUssd, setMixUssd] = useState(5);

  const [providers, setProviders] = useState<Provider[]>(() => clone(DEFAULT_PROVIDERS));
  // Defaults are the genuinely competitive combination, so the tool opens on
  // something worth looking at: Education is unbeatable on cards, and Squad's
  // 0.25% virtual account beats everything on transfers until it reaches the
  // ₦300 that Paystack charges flat — which happens at about ₦120,000.
  const [splitBy, setSplitBy] = useState<Record<Channel, string>>({
    card: "paystack-edu", transfer: "squad", ussd: "paystack-edu",
  });
  const [thresholdInput, setThresholdInput] = useState("120000");
  const [belowId, setBelowId] = useState("squad");
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
  ], [providers, splitBy, thresholdInput, belowId, aboveId]);

  const options = useMemo(
    () => strategies.map((s) => ({ key: JSON.stringify(s), strategy: s, ...runStrategy(s, inputs) })),
    [strategies, inputs]
  );
  // "Today" is always plain Paystack — that is what production actually runs.
  const today = useMemo(
    () => runStrategy({ kind: "single", providerId: "paystack" }, inputs),
    [inputs]
  );
  const best = useMemo(
    () => options.reduce((a, b) => (b.blendedParentKobo < a.blendedParentKobo ? b : a)),
    [options]
  );
  const savingPer = today.blendedParentKobo - best.blendedParentKobo;
  const savingAll = today.totalParentKobo - best.totalParentKobo;
  const sortedOptions = useMemo(
    () => [...options].sort((a, b) => a.blendedParentKobo - b.blendedParentKobo),
    [options]
  );
  // Bars are drawn relative to the dearest option so the spread is visible.
  const worstFee = useMemo(
    () => Math.max(...options.map((o) => o.blendedGatewayKobo), 1),
    [options]
  );

  const sweep = useMemo(() => SWEEP.map((fee) => ({
    fee,
    rows: strategies.map((s) => runStrategy(s, { ...inputs, baseKobo: fee * 100 })),
  })), [strategies, inputs]);

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

  const mixTotal = mixCard + mixTransfer + mixUssd || 1;
  const pctOf = (n: number) => Math.round((n / mixTotal) * 100);

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
            <Badge variant="outline" className="hidden sm:inline-flex">Internal tool</Badge>
            <Button variant="ghost" className="gap-2" onClick={() => navigate("/")}>
              <ArrowLeft className="w-4 h-4" /> <span className="hidden sm:inline">Home</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-8 space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold mb-2">Which payment gateway should we use?</h1>
          <p className="text-muted-foreground">
            Set up a realistic scenario below, and this works out what a parent would pay under each
            option. Change any underlined number.
          </p>
        </div>

        {/* ---------------------------- SCENARIO ------------------------- */}
        <Card>
          <CardContent className="pt-6 space-y-5">
            <p className="text-lg leading-relaxed">
              A school charges{" "}
              <InlineNum value={feeInput} onChange={setFeeInput} prefix="₦" width="w-28" />
              {" "}per student, and{" "}
              <InlineNum value={studentsInput} onChange={setStudentsInput} width="w-20" />
              {" "}students pay it.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2 border-t">
              <div className="space-y-5">
                <div>
                  <p className="text-sm font-medium mb-3">How do parents pay?</p>
                  <div className="space-y-3">
                    {([
                      ["Card", mixCard, setMixCard],
                      ["Bank transfer", mixTransfer, setMixTransfer],
                      ["USSD", mixUssd, setMixUssd],
                    ] as const).map(([label, val, set]) => (
                      <div key={label}>
                        <div className="flex items-baseline justify-between text-sm mb-1">
                          <span className="text-muted-foreground">{label}</span>
                          <span className="font-semibold tabular-nums">{pctOf(val)}%</span>
                        </div>
                        <input type="range" min={0} max={100} value={val}
                          onChange={(e) => set(Number(e.target.value))}
                          className="w-full accent-primary" />
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Gateways charge different rates per method, so this mix changes the answer.
                  </p>
                </div>
              </div>

              <div className="space-y-6">
                <Slider
                  label="Our platform fee"
                  value={platformPct} onChange={setPlatformPct}
                  min={0} max={10} step={0.25}
                  meaning={`We add ${platformPct}% (${naira(inputs.baseKobo * platformPct / 100)} on this fee) on top of what the school charges.`}
                />
                <Slider
                  label="Who pays the gateway's charge?"
                  value={parentSharePct} onChange={setParentSharePct}
                  min={0} max={100} step={5}
                  format={(v) => v === 100 ? "Parent pays it" : v === 0 ? "School absorbs it" : `${v}% parent`}
                  meaning={
                    parentSharePct === 100
                      ? "What we do today: it's added to the parent's bill, so the school receives its full fee."
                      : parentSharePct === 0
                        ? "The parent is charged only the fee plus our cut. The school's takings shrink by the gateway's charge."
                        : `The parent covers ${parentSharePct}% of it; the school gives up the other ${100 - parentSharePct}% from its fee.`
                  }
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ---------------------------- THE ANSWER ------------------------ */}
        <Card className="border-primary/30 bg-primary/[0.03]">
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground mb-1">The short answer</p>
            {savingPer > 0.5 ? (
              <>
                <p className="text-xl sm:text-2xl font-bold leading-snug mb-3">
                  Switching to <span className="text-primary">{best.label}</span> saves each parent{" "}
                  <span className="text-primary">{naira(savingPer)}</span> per payment.
                </p>
                <p className="text-muted-foreground">
                  A parent pays <strong className="text-foreground">{naira(today.blendedParentKobo)}</strong> today
                  and would pay <strong className="text-foreground">{naira(best.blendedParentKobo)}</strong> instead.
                  Across {inputs.students.toLocaleString()} payments that is{" "}
                  <strong className="text-foreground">{naira(savingAll)}</strong> kept in parents' pockets.
                </p>
              </>
            ) : (
              <p className="text-xl font-bold leading-snug">
                Nothing beats what we run today ({today.label}) under this scenario.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ---------------------------- OPTIONS --------------------------- */}
        <div>
          <h2 className="font-semibold mb-1">Every option, cheapest first</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Bars compare the gateway's charge — the only figure that differs between options.
          </p>
          <div className="space-y-3">
            {sortedOptions.map((o, idx) => {
              const isBest = o.key === best.key;
              const isToday = o.strategy.kind === "single" && o.strategy.providerId === "paystack";
              const diff = o.blendedParentKobo - today.blendedParentKobo;
              // Several routings often land on the same provider per channel and
              // so cost exactly the same. Say so, rather than showing what looks
              // like three identical cards for no reason.
              const tiedWith = idx > 0 && Math.abs(o.blendedParentKobo - sortedOptions[idx - 1].blendedParentKobo) < 0.5
                ? sortedOptions[idx - 1].label
                : null;
              return (
                <Card key={o.key} className={isBest ? "border-primary shadow-sm" : ""}>
                  <CardContent className="pt-5 space-y-3">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold">{o.label}</h3>
                          {isBest && (
                            <Badge className="bg-primary text-primary-foreground gap-1">
                              <Check className="w-3 h-3" /> Cheapest
                            </Badge>
                          )}
                          {isToday && <Badge variant="secondary">What we run today</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{o.detail}</p>
                        {tiedWith && (
                          <p className="text-xs text-muted-foreground mt-1 italic">
                            Identical cost to {tiedWith} — it routes to the same gateways here.
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs text-muted-foreground">One parent pays</p>
                        <p className="text-lg font-bold tabular-nums">{naira(o.blendedParentKobo)}</p>
                        {!isToday && Math.abs(diff) > 0.5 && (
                          <p className={`text-xs font-medium ${diff < 0 ? "text-primary" : "text-destructive"}`}>
                            {diff < 0 ? `${naira(-diff)} cheaper` : `${naira(diff)} dearer`} than today
                          </p>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Gateway's charge on one payment</p>
                      <FeeBar kobo={o.blendedGatewayKobo} maxKobo={worstFee} best={isBest} />
                    </div>
                    <div className="pt-1 border-t"><MoneySplit r={o} /></div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>

        {/* ---------------------------- GLOSSARY -------------------------- */}
        <Card className="bg-muted/30">
          <CardContent className="pt-5">
            <p className="text-sm font-semibold mb-3">What each number means</p>
            <dl className="space-y-3 text-sm">
              {[
                [Wallet, "One parent pays", "The whole amount charged at checkout for a single student's fee — the school's fee, our cut, and the gateway's charge on top, depending on who bears it."],
                [Building2, "School gets", "What actually lands in the school's bank account after everyone has taken their cut."],
                [Landmark, "Gateway takes", "What Paystack or Squad keeps for processing the payment. This is the only figure that changes between options, which is why the bars compare it."],
              ].map(([Icon, term, def]) => {
                const I = Icon as React.ElementType;
                return (
                  <div key={term as string} className="flex gap-3">
                    <I className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <div>
                      <dt className="font-medium inline">{term as string} — </dt>
                      <dd className="text-muted-foreground inline">{def as string}</dd>
                    </div>
                  </div>
                );
              })}
              <div className="flex gap-3">
                <span className="w-4 h-4 mt-0.5 shrink-0 rounded-full bg-[#F5C518]" />
                <div>
                  <dt className="font-medium inline">We get — </dt>
                  <dd className="text-muted-foreground inline">
                    EduLedgerNG's {platformPct}% platform fee. Identical under every option, so it never
                    affects which one wins.
                  </dd>
                </div>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* ---------------------------- DETAIL ---------------------------- */}
        <Disclose
          title="How each option behaves at other fee sizes"
          hint="Some options only win above or below a certain amount — this is where they cross over"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2">If the fee were…</th>
                  {options.map((o) => (
                    <th key={o.key} className="text-right font-medium px-3 py-2 whitespace-nowrap">{o.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sweep.map((row) => {
                  const min = Math.min(...row.rows.map((r) => r.blendedParentKobo));
                  return (
                    <tr key={row.fee} className="border-t">
                      <td className="px-4 py-2 font-medium tabular-nums">{naira(row.fee * 100)}</td>
                      {row.rows.map((r, i) => (
                        <td key={i} className={`px-3 py-2 text-right tabular-nums ${
                          r.blendedParentKobo === min ? "font-bold text-primary" : "text-muted-foreground"
                        }`}>
                          {naira(r.blendedGatewayKobo)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground px-4 py-3 border-t">
              Figures are the gateway's charge on one payment. Green is the cheapest at that fee size.
            </p>
          </div>
        </Disclose>

        <Disclose
          title="Mix and match gateways"
          hint="Use different providers for different payment methods, or for large versus small fees"
        >
          <CardContent className="pt-5 space-y-5">
            <div>
              <p className="text-sm font-medium mb-1">Different gateway per payment method</p>
              <p className="text-xs text-muted-foreground mb-3">
                Appears above as the "Custom split" option.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {CHANNELS.map((c) => (
                  <div key={c.id}>
                    <Label className="text-xs text-muted-foreground">{c.label}</Label>
                    <Select value={splitBy[c.id]} onValueChange={(v) => setSplitBy((m) => ({ ...m, [c.id]: v }))}>
                      <SelectTrigger className="h-9 mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t pt-5">
              <p className="text-sm font-medium mb-1">Different gateway by fee size</p>
              <p className="text-xs text-muted-foreground mb-3">
                Percentage rates win on small fees; flat rates win on large ones. Appears above as
                "Split by fee size".
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Switch at (₦)</Label>
                  <Input className="h-9 mt-1" inputMode="numeric" value={thresholdInput}
                    onChange={(e) => setThresholdInput(e.target.value.replace(/[^0-9]/g, ""))} />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Below that, use</Label>
                  <Select value={belowId} onValueChange={setBelowId}>
                    <SelectTrigger className="h-9 mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">At or above, use</Label>
                  <Select value={aboveId} onValueChange={setAboveId}>
                    <SelectTrigger className="h-9 mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </CardContent>
        </Disclose>

        <Disclose
          title="Gateway rates"
          hint="Published rates as of 3 Aug 2026 — edit them to model a deal you have negotiated"
        >
          <CardContent className="pt-5">
            <div className="flex justify-end mb-3">
              <Button variant="outline" size="sm" className="gap-2"
                onClick={() => setProviders(clone(DEFAULT_PROVIDERS))}>
                <RotateCcw className="w-3.5 h-3.5" /> Reset to published rates
              </Button>
            </div>
            <div className="space-y-4">
              {providers.map((p) => (
                <div key={p.id} className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="font-semibold text-sm">{p.name}</h3>
                    {p.negotiated && <Badge variant="secondary" className="shrink-0 text-[10px]">Price on request</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">{p.note}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="text-left font-medium pb-1.5 w-32">Method</th>
                          <th className="text-left font-medium pb-1.5">Rate</th>
                          <th className="text-left font-medium pb-1.5">Fixed charge</th>
                          <th className="text-left font-medium pb-1.5">Never more than</th>
                        </tr>
                      </thead>
                      <tbody>
                        {CHANNELS.map((ch) => {
                          const c = p.channels[ch.id];
                          return (
                            <tr key={ch.id}>
                              <td className="py-1 pr-2">
                                <span className={c.unsupported ? "text-muted-foreground/60 line-through" : ""}>
                                  {ch.label}
                                </span>
                              </td>
                              <td className="py-1 pr-2">
                                <div className="flex items-center gap-1">
                                  <Input className="h-7 w-16 text-xs" inputMode="decimal"
                                    value={String(+(c.percent * 100).toFixed(4))}
                                    onChange={(e) => setRate(p.id, ch.id, "percent", e.target.value.replace(/[^0-9.]/g, ""))} />
                                  <span className="text-muted-foreground">%</span>
                                </div>
                              </td>
                              <td className="py-1 pr-2">
                                <div className="flex items-center gap-1">
                                  <span className="text-muted-foreground">₦</span>
                                  <Input className="h-7 w-20 text-xs" inputMode="numeric"
                                    value={String(c.flat / 100)}
                                    onChange={(e) => setRate(p.id, ch.id, "flat", e.target.value.replace(/[^0-9.]/g, ""))} />
                                </div>
                              </td>
                              <td className="py-1">
                                <div className="flex items-center gap-1">
                                  <span className="text-muted-foreground">₦</span>
                                  <Input className="h-7 w-20 text-xs" inputMode="numeric" placeholder="no limit"
                                    value={c.cap == null ? "" : String(c.cap / 100)}
                                    onChange={(e) => setRate(p.id, ch.id, "cap", e.target.value.replace(/[^0-9.]/g, ""))} />
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Disclose>

        <div className="rounded-lg border p-4 flex items-start gap-3 text-xs text-muted-foreground">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p>
              <strong className="text-foreground">Paystack for Education</strong> has to be applied for.
              It is not the rate a new account gets.
            </p>
            <p>
              <strong className="text-foreground">Squad</strong> publishes its card and virtual-account
              rates, and offers custom pricing on high volume — so these are a ceiling, not a floor.
              Its USSD rate is not published; the 1% here comes from a third-party summary and is the
              least reliable number on this page.
            </p>
            <p>Confirm both directly before integrating. This model is only as good as the rates in it.</p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default GatewayLab;
