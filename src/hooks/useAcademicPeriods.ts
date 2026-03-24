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

// Default sessions to auto-create if none exist
const DEFAULT_SESSIONS = ["2024/2025", "2025/2026", "2026/2027"];

export const useAcademicPeriods = (schoolId: string | undefined) => {
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [terms, setTerms] = useState<AcademicTerm[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedTermId, setSelectedTermId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const loadPeriods = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);

    let { data: sessionsData } = await supabase
      .from("academic_sessions")
      .select("*")
      .eq("school_id", schoolId)
      .order("name", { ascending: true });

    let allSessions = (sessionsData || []) as AcademicSession[];

    // Auto-create default sessions if none exist
    if (allSessions.length === 0) {
      for (const name of DEFAULT_SESSIONS) {
        const { data: newSession } = await supabase
          .from("academic_sessions")
          .insert({ school_id: schoolId, name, is_current: false } as any)
          .select()
          .single();

        if (newSession) {
          await supabase.from("academic_terms").insert([
            { session_id: newSession.id, school_id: schoolId, name: "Term 1", is_current: false },
            { session_id: newSession.id, school_id: schoolId, name: "Term 2", is_current: false },
            { session_id: newSession.id, school_id: schoolId, name: "Term 3", is_current: false },
          ] as any);
        }
      }
      // Reload after creation
      const { data: reloaded } = await supabase
        .from("academic_sessions")
        .select("*")
        .eq("school_id", schoolId)
        .order("name", { ascending: true });
      allSessions = (reloaded || []) as AcademicSession[];
    }

    setSessions(allSessions);

    // Default selection: latest session (by name descending) and Term 1
    if (!selectedSessionId && allSessions.length > 0) {
      // Pick the latest session by name (e.g. 2025/2026 > 2024/2025)
      const sorted = [...allSessions].sort((a, b) => b.name.localeCompare(a.name));
      setSelectedSessionId(sorted[0].id);
    }

    const { data: termsData } = await supabase
      .from("academic_terms")
      .select("*")
      .eq("school_id", schoolId)
      .order("created_at", { ascending: true });

    const allTerms = (termsData || []) as AcademicTerm[];
    setTerms(allTerms);

    setLoading(false);
  }, [schoolId]);

  useEffect(() => {
    loadPeriods();
  }, [loadPeriods]);

  // When session changes, auto-select Term 1
  useEffect(() => {
    if (!selectedSessionId || terms.length === 0) return;
    const sessionTerms = terms.filter((t) => t.session_id === selectedSessionId);
    const term1 = sessionTerms.find((t) => t.name === "Term 1") || sessionTerms[0];
    if (term1) setSelectedTermId(term1.id);
  }, [selectedSessionId, terms]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const selectedTerm = terms.find((t) => t.id === selectedTermId);
  const termsForSelectedSession = terms.filter((t) => t.session_id === selectedSessionId);

  return {
    sessions,
    terms,
    selectedSessionId,
    selectedTermId,
    setSelectedSessionId,
    setSelectedTermId,
    termsForSelectedSession,
    selectedSession,
    selectedTerm,
    loading,
    reload: loadPeriods,
  };
};
