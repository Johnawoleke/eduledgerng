import React from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { GraduationCap, Shield, Users, Wallet, ArrowRight } from "lucide-react";

const LandingPage = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center justify-between h-16 px-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">EduLedger<span className="text-primary font-bold">NG</span></span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate("/login")}>
              Sign In
            </Button>
            <Button onClick={() => navigate("/register")}>
              Register School
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-3xl text-center">
          <h1 className="text-4xl sm:text-5xl font-bold text-foreground mb-6">
            School Records,
            <br />
            <span className="text-primary">Simplified</span>
          </h1>
          <p className="text-lg text-muted-foreground mb-8 max-w-2xl mx-auto">
            Register your school, manage students, track fees and payments, and give each student a secure portal — all in one place.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button size="lg" onClick={() => navigate("/register")} className="gap-2">
              Register Your School <ArrowRight className="w-4 h-4" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => navigate("/login")}>
              Sign In
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 px-4 bg-muted/50">
        <div className="container mx-auto max-w-4xl">
          <h2 className="text-2xl font-bold text-center mb-10">How It Works</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <Card>
              <CardContent className="pt-6 text-center space-y-3">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto">
                  <GraduationCap className="w-6 h-6 text-primary" />
                </div>
                <h3 className="font-semibold">1. Register School</h3>
                <p className="text-sm text-muted-foreground">
                  Sign up and get your own unique portal link instantly.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center space-y-3">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto">
                  <Users className="w-6 h-6 text-primary" />
                </div>
                <h3 className="font-semibold">2. Add Students & Fees</h3>
                <p className="text-sm text-muted-foreground">
                  Add your students and set their fee items from the admin dashboard.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center space-y-3">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto">
                  <Wallet className="w-6 h-6 text-primary" />
                </div>
                <h3 className="font-semibold">3. Students Pay Online</h3>
                <p className="text-sm text-muted-foreground">
                  Students log in on your portal to view and pay their fees.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Data Isolation */}
      <section className="py-16 px-4">
        <div className="container mx-auto max-w-2xl text-center">
          <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Shield className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-2xl font-bold mb-4">Complete Data Isolation</h2>
          <p className="text-muted-foreground">
            Each school's data is completely separate. No school can see another school's information. No student can see another student's data. Your data is secure.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8 px-4">
        <div className="container mx-auto text-center text-sm text-muted-foreground">
          <p>EduLedgerNG &copy; {new Date().getFullYear()} — School Fee Management System</p>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
