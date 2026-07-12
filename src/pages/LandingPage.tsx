import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  GraduationCap,
  Shield,
  Users,
  Wallet,
  ArrowRight,
  Menu,
  X,
  CreditCard,
  Receipt,
  CalendarDays,
  Building2,
  Layers,
  Baby,
  School,
  Mail,
  MessageCircle,
} from "lucide-react";

// Anchor links in the top nav — each scrolls to a section with the same id.
const NAV_LINKS = [
  { label: "About", id: "about" },
  { label: "Features", id: "features" },
  { label: "Solutions", id: "solutions" },
  { label: "Contact", id: "contact" },
];

const LandingPage = () => {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const goToSection = (id: string) => {
    setMobileOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Top navigation */}
      <header className="sticky top-0 z-50 border-b bg-card/90 backdrop-blur">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="flex items-center gap-2"
              aria-label="EduLedgerNG home"
            >
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                <GraduationCap className="w-4 h-4 text-primary-foreground" />
              </div>
              <span className="font-bold text-lg">
                EduLedger<span className="text-primary font-bold">NG</span>
              </span>
            </button>

            {/* Desktop nav links */}
            <nav className="hidden md:flex items-center gap-1">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.id}
                  href={`#${link.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    goToSection(link.id);
                  }}
                  className="px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors rounded-md"
                >
                  {link.label}
                </a>
              ))}
            </nav>

            {/* Desktop actions */}
            <div className="hidden md:flex items-center gap-2">
              <Button variant="ghost" onClick={() => navigate("/login")}>
                Log In
              </Button>
              <Button onClick={() => navigate("/register")}>Register</Button>
            </div>

            {/* Mobile hamburger */}
            <button
              className="md:hidden p-2 -mr-2 rounded-md text-foreground hover:bg-muted transition-colors"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>

          {/* Mobile menu */}
          {mobileOpen && (
            <div className="md:hidden border-t py-3 space-y-1">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.id}
                  href={`#${link.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    goToSection(link.id);
                  }}
                  className="block px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                >
                  {link.label}
                </a>
              ))}
              <div className="flex flex-col gap-2 pt-2 px-1">
                <Button variant="outline" onClick={() => navigate("/login")}>
                  Log In
                </Button>
                <Button onClick={() => navigate("/register")}>Register</Button>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-3xl text-center">
          <h1 className="text-4xl sm:text-5xl font-bold text-foreground mb-6 text-balance">
            Secure Payments
            <br />
            <span className="text-primary">Simplified Records</span>
          </h1>
          <p className="text-lg text-muted-foreground mb-8 max-w-2xl mx-auto">
            The fee-management platform for Nigerian private schools — from nursery to senior
            secondary. Register your school, manage students and fees by session and term, and let
            parents pay online in minutes.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button size="lg" onClick={() => navigate("/register")} className="gap-2">
              Register Your School <ArrowRight className="w-4 h-4" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => goToSection("features")}>
              See how it works
            </Button>
          </div>
        </div>
      </section>

      {/* About */}
      <section id="about" className="scroll-mt-20 py-16 px-4 bg-muted/50">
        <div className="container mx-auto max-w-4xl">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <p className="text-sm font-semibold uppercase tracking-wide text-primary mb-2">About</p>
            <h2 className="text-2xl sm:text-3xl font-bold mb-4 text-balance">
              Built for how Nigerian schools actually run
            </h2>
            <p className="text-muted-foreground">
              EduLedgerNG replaces cash, paper receipts, and scattered spreadsheets with one simple
              system. Owners and bursars manage fees per class, term, and session; parents and
              students pay online; and every payment is recorded and receipted automatically.
            </p>
          </div>
          <Card>
            <CardContent className="pt-6 flex flex-col sm:flex-row items-center gap-4 text-center sm:text-left">
              <div className="w-12 h-12 shrink-0 rounded-xl bg-primary/10 flex items-center justify-center">
                <Shield className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">Complete data isolation</h3>
                <p className="text-sm text-muted-foreground">
                  Every school's data is fully separated. No school can see another's information,
                  and no student can see another student's records. Your data stays yours.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20 py-16 px-4">
        <div className="container mx-auto max-w-5xl">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <p className="text-sm font-semibold uppercase tracking-wide text-primary mb-2">
              Features
            </p>
            <h2 className="text-2xl sm:text-3xl font-bold mb-4 text-balance">
              Everything you need to collect fees
            </h2>
            <p className="text-muted-foreground">
              Set up in minutes and run the whole fee cycle from one dashboard.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: CreditCard,
                title: "Online fee payments",
                body: "Parents pay by card in a few taps. Money settles straight into your school's own bank account.",
              },
              {
                icon: Wallet,
                title: "Fee management",
                body: "Set fees per class, term, and session. Bursars propose, owners approve — then fees are locked for the year.",
              },
              {
                icon: Users,
                title: "Student portals",
                body: "Each student gets a secure login to view their balance and pay outstanding fees.",
              },
              {
                icon: Receipt,
                title: "Instant receipts",
                body: "Every successful payment generates a PDF receipt with a full breakdown of what was paid.",
              },
              {
                icon: CalendarDays,
                title: "Sessions & terms",
                body: "Organize students, fees, and payments by academic session and term, exactly as your school does.",
              },
              {
                icon: Building2,
                title: "Multiple branches",
                body: "Run several schools from one account — each with its own students, fees, and bank account.",
              },
            ].map((f) => (
              <Card key={f.title}>
                <CardContent className="pt-6 space-y-3">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                    <f.icon className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="font-semibold">{f.title}</h3>
                  <p className="text-sm text-muted-foreground">{f.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Solutions */}
      <section id="solutions" className="scroll-mt-20 py-16 px-4 bg-muted/50">
        <div className="container mx-auto max-w-5xl">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <p className="text-sm font-semibold uppercase tracking-wide text-primary mb-2">
              Solutions
            </p>
            <h2 className="text-2xl sm:text-3xl font-bold mb-4 text-balance">
              For every kind of private school
            </h2>
            <p className="text-muted-foreground">
              One platform that fits your structure — whether you run one campus or several.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              {
                icon: Baby,
                title: "Nursery & Primary",
                body: "Classes from Nursery 1 through Primary 6, with parents paying on behalf of younger children.",
              },
              {
                icon: School,
                title: "Secondary schools",
                body: "Junior and Senior Secondary (JSS1–SSS3), with students able to view and pay their own fees.",
              },
              {
                icon: Layers,
                title: "Multi-branch groups",
                body: "Owners managing several schools get one login and a dashboard for every branch.",
              },
            ].map((s) => (
              <Card key={s.title}>
                <CardContent className="pt-6 space-y-3">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                    <s.icon className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="font-semibold">{s.title}</h3>
                  <p className="text-sm text-muted-foreground">{s.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Contact */}
      <section id="contact" className="scroll-mt-20 py-16 px-4 bg-muted/50">
        <div className="container mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary mb-2">Contact</p>
          <h2 className="text-2xl sm:text-3xl font-bold mb-4 text-balance">
            Getting your school set up?
          </h2>
          <p className="text-muted-foreground mb-8 max-w-md mx-auto">
            Tell us about your school and we'll help you onboard your students and start collecting
            fees online.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {/* TODO: replace with your real support email and WhatsApp number */}
            <Button size="lg" variant="outline" className="gap-2" asChild>
              <a href="mailto:hello@eduledgerng.com">
                <Mail className="w-4 h-4" /> Email us
              </a>
            </Button>
            <Button size="lg" className="gap-2" asChild>
              <a href="https://wa.me/2340000000000" target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-4 h-4" /> Chat on WhatsApp
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8 px-4">
        <div className="container mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <p>EduLedgerNG &copy; {new Date().getFullYear()} — School Fee Management</p>
          <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            {NAV_LINKS.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  goToSection(link.id);
                }}
                className="hover:text-foreground transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
