import React, { createContext, useContext, useEffect, ReactNode, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

interface SupabaseAuthContextType {
  isReady: boolean;
  isSignedIn: boolean;
  setPendingRedirect: (url: string) => void;
}

const SupabaseAuthContext = createContext<SupabaseAuthContextType>({ 
  isReady: false, 
  isSignedIn: false,
  setPendingRedirect: () => {},
});

export const SupabaseAuthProvider = ({ children }: { children: ReactNode }) => {
  const [isReady, setIsReady] = React.useState(false);
  const [isSignedIn, setIsSignedIn] = React.useState(false);
  const pendingRedirectRef = useRef<string | null>(null);

  const setPendingRedirect = (url: string) => {
    pendingRedirectRef.current = url;
  };

  const clearAuthState = () => {
    try {
      // Clear Supabase auth tokens safely
      localStorage.removeItem("sb-auth-token");
      localStorage.removeItem("sb-refresh-token");
      
      // Clear app-specific state data
      localStorage.removeItem("pity_student");
      localStorage.removeItem("pity_fees");
      localStorage.removeItem("pity_payments");
      localStorage.removeItem("pity_credentials");
      localStorage.removeItem("pity_school");
      localStorage.removeItem("pity_slug");
      
      localStorage.removeItem("supabase.auth.token");
      localStorage.removeItem("supabase.auth.expires_at");
      
      setIsSignedIn(false);
      
      // Determine destination
      const redirectUrl = pendingRedirectRef.current || "/";
      
      // 🛑 THE LOOP BREAK SHIELD: Only reload the window if we are NOT already sitting on the target page!
      if (window.location.pathname !== redirectUrl) {
        window.location.href = redirectUrl;
      } else {
        // We are already exactly where we want to be! Clear the ref tracker and stay put safely.
        pendingRedirectRef.current = null;
      }
    } catch (err) {
      console.error("Error clearing auth state:", err);
      if (window.location.pathname !== "/") {
        window.location.href = "/";
      }
    }
  };

  useEffect(() => {
    const checkSession = async () => {
      const { data, error } = await supabase.auth.getSession();
      
      if (error || !data?.session) {
        // Safety: Only clear state if we aren't already sitting on a clean school layout portal page
        if (!window.location.pathname.startsWith("/school/")) {
          clearAuthState();
        }
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
    <SupabaseAuthContext.Provider value={{ isReady, isSignedIn, setPendingRedirect }}>
      {children}
    </SupabaseAuthContext.Provider>
  );
};

export const useSupabaseAuth = () => useContext(SupabaseAuthContext);
