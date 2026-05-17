import React, { createContext, useContext, useEffect, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

interface SupabaseAuthContextType {
  isReady: boolean;
  isSignedIn: boolean;
}

const SupabaseAuthContext = createContext<SupabaseAuthContextType>({ isReady: false, isSignedIn: false });

/**
 * SupabaseAuthProvider manages Supabase auth state lifecycle.
 * 
 * Key responsibilities:
 * 1. Monitors auth.onAuthStateChange() events
 * 2. Clears corrupted localStorage on sign-out/invalid session
 * 3. Breaks infinite auth loops by hard-redirecting to home
 * 4. Prevents blank screens from auth state mismatches
 */
export const SupabaseAuthProvider = ({ children }: { children: ReactNode }) => {
  const [isReady, setIsReady] = React.useState(false);
  const [isSignedIn, setIsSignedIn] = React.useState(false);

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
        // Clear everything and redirect on sign-out or session loss
        clearAuthState();
        return;
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        setIsSignedIn(true);
      }

      if (event === "USER_UPDATED") {
        // Session is still valid, just user data changed
        setIsSignedIn(true);
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  /**
   * Clears all auth-related state from localStorage and redirects to home.
   * This prevents infinite loops when session tokens are invalid/expired.
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
      
      // Update state
      setIsSignedIn(false);
      
      // Hard redirect to home to break any redirect loops
      if (window.location.pathname !== "/") {
        window.location.href = "/";
      }
    } catch (err) {
      console.error("Error clearing auth state:", err);
      // Fallback: still redirect even if cleanup fails
      window.location.href = "/";
    }
  };

  return (
    <SupabaseAuthContext.Provider value={{ isReady, isSignedIn }}>
      {children}
    </SupabaseAuthContext.Provider>
  );
};

export const useSupabaseAuth = () => useContext(SupabaseAuthContext);
