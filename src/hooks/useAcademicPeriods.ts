import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AcademicSession {
  id: string;
  school_id: string;
  name: string;
  is_current?: boolean | null;
  start_date: string | null;
  end_date: string | null;
  start_year: number | null;
  end_year: number | null;
  created_at: string;
}

export interface AcademicTerm {
  id: string;
  session_id: string;
  school_id: string;
  name: string;
  is_current?: boolean | null;
  start_date: string | null;
  end_date: string | null;
  term_number: number | null;
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

    let { data: sessionsData } = await supabase
      .from("sessions" as any)
      .select("*")
      .eq("school_id", schoolId)
      .order("start_year", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true });

    let allSessions = (sessionsData || []) as AcademicSession[];

    // Safety fallback: initialize one dynamic current session + 3 terms when empty.
    if (allSessions.length === 0) {
      const currentYear = new Date().getFullYear();
      const nextYear = currentYear + 1;
      const sessionName = `${currentYear}/${nextYear}`;

      const { data: newSession } = await supabase
        .from("sessions" as any)
        .insert({
          school_id: schoolId,
          name: sessionName,
          start_year: currentYear,
          end_year: nextYear,
          is_current: true,
        } as any)
        .select()
        .single();

      if (newSession) {
        await supabase.from("terms" as any).insert([
          { session_id: newSession.id, school_id: schoolId, name: "Term 1", term_number: 1, is_current: true },
          { session_id: newSession.id, school_id: schoolId, name: "Term 2", term_number: 2, is_current: false },
          { session_id: newSession.id, school_id: schoolId, name: "Term 3", term_number: 3, is_current: false },
        ] as any);
      }

      const { data: reloaded } = await supabase
        .from("sessions" as any)
        .select("*")
        .eq("school_id", schoolId)
        .order("start_year", { ascending: true, nullsFirst: false })
        .order("name", { ascending: true });
      allSessions = (reloaded || []) as AcademicSession[];
    }

    setSessions(allSessions);

    // Default selection: DB current session, else latest by year/name.
    if (!selectedSessionId && allSessions.length > 0) {
      const currentSession = allSessions.find((s) => s.is_current);
      if (currentSession) {
        setSelectedSessionId(currentSession.id);
      } else {
        const sorted = [...allSessions].sort((a, b) => {
          const ay = a.start_year ?? 0;
          const by = b.start_year ?? 0;
          if (ay !== by) return by - ay;
          return b.name.localeCompare(a.name);
        });
        setSelectedSessionId(sorted[0].id);
      }
    }

    const { data: termsData } = await supabase
      .from("terms" as any)
      .select("*")
      .eq("school_id", schoolId)
      .order("term_number", { ascending: true });

    const allTerms = (termsData || []) as AcademicTerm[];
    setTerms(allTerms);

    setLoading(false);
  }, [schoolId]);

  useEffect(() => {
    loadPeriods();
  }, [loadPeriods]);

  // When session changes, auto-select current term in that session, else Term 1.
  useEffect(() => {
    if (!selectedSessionId || terms.length === 0) return;
    const sessionTerms = terms
      .filter((t) => t.session_id === selectedSessionId)
      .sort((a, b) => (a.term_number || 0) - (b.term_number || 0));
    const currentTerm = sessionTerms.find((t) => t.is_current);
    const defaultTerm = currentTerm || sessionTerms.find((t) => t.term_number === 1) || sessionTerms[0];
    if (defaultTerm) setSelectedTermId(defaultTerm.id);
  }, [selectedSessionId, terms]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const selectedTerm = terms.find((t) => t.id === selectedTermId);
  const termsForSelectedSession = terms
    .filter((t) => t.session_id === selectedSessionId)
    .sort((a, b) => (a.term_number || 0) - (b.term_number || 0));

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
