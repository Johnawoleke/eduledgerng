import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { SchoolProvider } from "@/lib/schoolContext";
import { AcademicPeriodSelector } from "./components/AcademicPeriodSelector";
import LandingPage from "./pages/LandingPage";
import RegisterSchool from "./pages/RegisterSchool";
import OwnerLogin from "./pages/OwnerLogin";
import SchoolPortal from "./pages/SchoolPortal";
import SchoolStudentDashboard from "./pages/SchoolStudentDashboard";
import SchoolAdminDashboard from "./pages/SchoolAdminDashboard";
import ChangePinPage from "./pages/ChangePinPage";
import ReceiptPage from "./pages/ReceiptPage";
import SchoolSettingsPage from "./pages/SchoolSettingsPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <SchoolProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          {/* This adds the Term Switcher to the top of your app */}
          <div className="bg-white border-b p-2 flex justify-end sticky top-0 z-50">
            <AcademicPeriodSelector />
          </div>
          
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/register" element={<RegisterSchool />} />
            <Route path="/login" element={<OwnerLogin />} />
            <Route path="/school/:slug" element={<SchoolPortal />} />
            <Route path="/school/:slug/student/*" element={<SchoolStudentDashboard />} />
            <Route path="/school/:slug/admin/*" element={<SchoolAdminDashboard />} />
            <Route path="/school/:slug/change-pin" element={<ChangePinPage />} />
            <Route path="/school/:slug/settings" element={<SchoolSettingsPage />} />
            <Route path="/receipt/:id" element={<ReceiptPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </SchoolProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
