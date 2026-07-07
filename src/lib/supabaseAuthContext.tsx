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

  // This provider only tracks whether a STAFF (Supabase) session exists.
  // It must NOT touch the student session (the pity_* localStorage keys managed
  // by schoolContext) — those are a separate auth system and clearing them here
  // silently logged students out on every reload. It also must not hand-delete
  // Supabase's token (the real key is sb-<ref>-auth-token, which supabase-js
  // owns); if a session is invalid, supabase-js handles it. Protected pages
  // guard themselves (they redirect to /login or /school/:slug when there is no
  // user), so this provider does not redirect.
  useEffect(() => {
    const checkSession = async () => {
      const { data } = await supabase.auth.getSession();
      setIsSignedIn(!!data?.session);
      setIsReady(true);
    };

    checkSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsSignedIn(!!session);
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
