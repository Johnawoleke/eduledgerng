import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { SchoolProvider } from "@/lib/schoolContext";
import { SupabaseAuthProvider } from "@/lib/supabaseAuthContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import LandingPage from "./pages/LandingPage";
import RegisterSchool from "./pages/RegisterSchool";
import OwnerLogin from "./pages/OwnerLogin";
import SchoolPortal from "./pages/SchoolPortal";
import ResetPassword from "./pages/ResetPassword";
import SchoolStudentDashboard from "./pages/SchoolStudentDashboard";
import SchoolAdminDashboard from "./pages/SchoolAdminDashboard";
import ChangePinPage from "./pages/ChangePinPage";
import ReceiptPage from "./pages/ReceiptPage";
import SchoolSettingsPage from "./pages/SchoolSettingsPage";
import NotFound from "./pages/NotFound";
import Dashboard from "./pages/Dashboard";
import Register from "./pages/RegisterPage";
import AccountRecovery from "./pages/AccountRecovery";
import ChangePassword from "./pages/ChangePassword";

const queryClient = new QueryClient();

const App = () => {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SupabaseAuthProvider>
          <TooltipProvider>
            <SchoolProvider>
              <Toaster />
              <Sonner />
              <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <Routes>
                  <Route path="/" element={<LandingPage />} />
                  <Route path="/register-school" element={<RegisterSchool />} />
                  <Route path="/register" element={<Register />} />
                  <Route path="/login" element={<OwnerLogin />} />
                  <Route path="/school/:slug" element={<SchoolPortal />} />
                  <Route path="/school/:slug/reset-password" element={<ResetPassword />} />
                  <Route path="/school/:slug/student/*" element={<SchoolStudentDashboard />} />
                  <Route path="/school/:slug/admin/*" element={<SchoolAdminDashboard />} />
                  <Route path="/school/:slug/change-pin" element={<ChangePinPage />} />
                  <Route path="/school/:slug/settings" element={<SchoolSettingsPage />} />
                  <Route path="/main-dashboard" element={<Dashboard />} />
                  <Route path="/school/:slug/receipt/:paymentId" element={<ReceiptPage />} />
                  <Route path="/account-recovery" element={<AccountRecovery />} />
                  <Route path="/change-password" element={<ChangePassword />} />
                  <Route path="/owner-login" element={<OwnerLogin />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </BrowserRouter>
            </SchoolProvider>
          </TooltipProvider>
        </SupabaseAuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
