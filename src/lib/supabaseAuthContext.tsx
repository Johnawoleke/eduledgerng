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

/**
 * SupabaseAuthProvider manages Supabase auth state lifecycle.
 */
export const SupabaseAuthProvider = ({ children }: { children: ReactNode }) => {
  const [isReady, setIsReady] = React.useState(false);
  const [isSignedIn, setIsSignedIn] = React.useState(false);
  
  // Use a mutable ref to hold the redirect target. 
  // This bypasses closure issues so background auth listeners always see the fresh value instantly!
  const pendingRedirectRef = useRef<string | null>(null);

  const setPendingRedirect = (url: string) => {
    pendingRedirectRef.current = url;
  };

  /**
   * Clears all auth-related state from localStorage and redirects.
   */
  const clearAuthState = () => {
    try {
      // Clear Supabase auth tokens
      localStorage.removeItem("sb-auth-token");
      localStorage.removeItem("sb-refresh-token");
      
      // Clear app-specific auth/session data (from SchoolContext)
      localStorage.removeItem("pity_student");
      localStorage.removeItem("pity_fees");
      localStorage.removeItem("pity_payments");
      localStorage.removeItem("pity_credentials");
      localStorage.removeItem("pity_school");
      localStorage.removeItem("pity_slug");
      
      // Clear legacy auth tokens if they exist
      localStorage.removeItem("supabase.auth.token");
      localStorage.removeItem("supabase.auth.expires_at");
      
      // Update React state
      setIsSignedIn(false);
      
      // Pull destination from ref tracker, fallback to active route or home base
      const redirectUrl = pendingRedirectRef.current || window.location.pathname || "/";
      
      // Force window redirect to completely dump current memory space
      window.location.href = redirectUrl;
    } catch (err) {
      console.error("Error clearing auth state:", err);
      window.location.href = pendingRedirectRef.current || "/";
    }
  };

  useEffect(() => {
    // Check current session on mount
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

    // Subscribe to auth state changes
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