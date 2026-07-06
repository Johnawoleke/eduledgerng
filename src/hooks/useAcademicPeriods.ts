import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type AcademicSession = Tables<"sessions">;
export type AcademicTerm = Tables<"terms">;

export const useAcademicPeriods = (schoolId: string | undefined) => {
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [terms, setTerms] = useState<AcademicTerm[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedTermId, setSelectedTermId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const loadPeriods = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);

    const fetchSessions = () =>
      supabase
        .from("sessions")
        .select("*")
        .eq("school_id", schoolId)
        .order("start_year", { ascending: true, nullsFirst: false })
        .order("name", { ascending: true });

    let { data: sessionsData, error: sessionsError } = await fetchSessions();
    if (sessionsError) console.error("Failed to load sessions:", sessionsError.message);

    let allSessions = sessionsData || [];

    // Safety fallback: initialize one dynamic current session + 3 terms when empty.
    // Requires an authenticated school member (RLS) — for students this silently
    // no-ops and the selectors stay hidden until the school seeds its periods.
    if (allSessions.length === 0 && !sessionsError) {
      const currentYear = new Date().getFullYear();
      const nextYear = currentYear + 1;

      const { data: newSession, error: insertError } = await supabase
        .from("sessions")
        .insert({
          school_id: schoolId,
          name: `${currentYear}/${nextYear}`,
          start_year: currentYear,
          end_year: nextYear,
          is_current: true,
        })
        .select()
        .single();

      if (!insertError && newSession) {
        await supabase.from("terms").insert([
          { session_id: newSession.id, school_id: schoolId, name: "Term 1", term_number: 1, is_current: true },
          { session_id: newSession.id, school_id: schoolId, name: "Term 2", term_number: 2, is_current: false },
          { session_id: newSession.id, school_id: schoolId, name: "Term 3", term_number: 3, is_current: false },
        ]);

        const { data: reloaded } = await fetchSessions();
        allSessions = reloaded || [];
      }
    }

    setSessions(allSessions);

    const { data: termsData, error: termsError } = await supabase
      .from("terms")
      .select("*")
      .eq("school_id", schoolId)
      .order("term_number", { ascending: true });
    if (termsError) console.error("Failed to load terms:", termsError.message);

    setTerms(termsData || []);
    setLoading(false);
  }, [schoolId]);

  useEffect(() => {
    loadPeriods();
  }, [loadPeriods]);

  // Default selection: DB current session, else latest by year/name.
  useEffect(() => {
    if (selectedSessionId || sessions.length === 0) return;
    const currentSession = sessions.find((s) => s.is_current);
    if (currentSession) {
      setSelectedSessionId(currentSession.id);
    } else {
      const sorted = [...sessions].sort((a, b) => {
        const ay = a.start_year ?? 0;
        const by = b.start_year ?? 0;
        if (ay !== by) return by - ay;
        return b.name.localeCompare(a.name);
      });
      setSelectedSessionId(sorted[0].id);
    }
  }, [sessions, selectedSessionId]);

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
