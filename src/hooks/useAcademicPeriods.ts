import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AcademicSession {
  id: string;
  school_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  created_at: string;
}

export interface AcademicTerm {
  id: string;
  session_id: string;
  school_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  created_at: string;
}

export const useAcademicPeriods = (schoolId: string | undefined) => {
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [terms, setTerms] = useState<AcademicTerm[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedTermId, setSelectedTermId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const loadPeriods = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);

    const { data: sessionsData } = await supabase
      .from("academic_sessions")
      .select("*")
      .eq("school_id", schoolId)
      .order("created_at", { ascending: false });

    const allSessions = (sessionsData || []) as AcademicSession[];
    setSessions(allSessions);

    const currentSession = allSessions.find((s) => s.is_current) || allSessions[0];
    if (currentSession && !selectedSessionId) {
      setSelectedSessionId(currentSession.id);
    }

    const { data: termsData } = await supabase
      .from("academic_terms")
      .select("*")
      .eq("school_id", schoolId)
      .order("created_at", { ascending: true });

    const allTerms = (termsData || []) as AcademicTerm[];
    setTerms(allTerms);

    if (currentSession && !selectedTermId) {
      const currentTerm = allTerms.find((t) => t.session_id === currentSession.id && t.is_current) ||
        allTerms.find((t) => t.session_id === currentSession.id);
      if (currentTerm) setSelectedTermId(currentTerm.id);
    }

    setLoading(false);
  }, [schoolId]);

  useEffect(() => {
    loadPeriods();
  }, [loadPeriods]);

  // When session changes, auto-select its current term
  useEffect(() => {
    if (!selectedSessionId || terms.length === 0) return;
    const sessionTerms = terms.filter((t) => t.session_id === selectedSessionId);
    const currentTerm = sessionTerms.find((t) => t.is_current) || sessionTerms[0];
    if (currentTerm) setSelectedTermId(currentTerm.id);
  }, [selectedSessionId, terms]);

  const currentSession = sessions.find((s) => s.is_current);
  const currentTerm = terms.find((t) => t.is_current && t.session_id === currentSession?.id);
  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const selectedTerm = terms.find((t) => t.id === selectedTermId);
  const termsForSelectedSession = terms.filter((t) => t.session_id === selectedSessionId);

  const isFutureSession = (sessionId: string) => {
    if (!currentSession) return false;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || !currentSession) return false;
    return session.created_at > currentSession.created_at && !session.is_current;
  };

  const isFutureTerm = (termId: string) => {
    const term = terms.find((t) => t.id === termId);
    if (!term) return false;
    if (isFutureSession(term.session_id)) return true;
    if (term.session_id !== currentSession?.id) return false;
    if (!currentTerm) return false;
    return term.created_at > currentTerm.created_at && !term.is_current;
  };

  return {
    sessions,
    terms,
    selectedSessionId,
    selectedTermId,
    setSelectedSessionId,
    setSelectedTermId,
    termsForSelectedSession,
    currentSession,
    currentTerm,
    selectedSession,
    selectedTerm,
    isFutureSession,
    isFutureTerm,
    loading,
    reload: loadPeriods,
  };
};
