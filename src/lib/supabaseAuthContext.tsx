import React, { createContext, useContext, useEffect, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

interface SupabaseAuthContextType {
  isReady: boolean;
  isSignedIn: boolean;
}

const SupabaseAuthContext = createContext<SupabaseAuthContextType>({ 
  isReady: false, 
  isSignedIn: false,
});

export const SupabaseAuthProvider = ({ children }: { children: ReactNode }) => {
  const [isReady, setIsReady] = React.useState(false);
  const [isSignedIn, setIsSignedIn] = React.useState(false);

  const clearAuthState = () => {
    try {
      // 1. Clear Supabase auth tokens safely
      localStorage.removeItem("sb-auth-token");
      localStorage.removeItem("sb-refresh-token");
      
      // 2. Clear app-specific session data
      localStorage.removeItem("pity_student");
      localStorage.removeItem("pity_fees");
      localStorage.removeItem("pity_payments");
      localStorage.removeItem("pity_credentials");
      localStorage.removeItem("pity_school");
      localStorage.removeItem("pity_slug");
      
      localStorage.removeItem("supabase.auth.token");
      localStorage.removeItem("supabase.auth.expires_at");
      
      setIsSignedIn(false);
      
      // 🛡️ LOOP BREAKER SHIELD:
      // If the user is already on a school path (like /school/qwert), DO NOT force a browser redirect.
      // Let the page render naturally so they can see the Admin/Student selection buttons safely.
      if (window.location.pathname.startsWith("/school/")) {
        return; 
      }
      
      // Only redirect to home if they are logged out out-of-bounds
      if (window.location.pathname !== "/") {
        window.location.href = "/";
      }
    } catch (err) {
      console.error("Error clearing auth state:", err);
    }
  };

  useEffect(() => {
    const checkSession = async () => {
      const { data, error } = await supabase.auth.getSession();
      
      if (error || !data?.session) {
        clearAuthState();
      } else {
        setIsSignedIn(true);
      }
      setIsReady(true);
    };

    checkSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        clearAuthState();
        return;
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        setIsSignedIn(true);
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  return (
    <SupabaseAuthContext.Provider value={{ isReady, isSignedIn }}>
      {children}
    </SupabaseAuthContext.Provider>
  );
};

export const useSupabaseAuth = () => useContext(SupabaseAuthContext);
