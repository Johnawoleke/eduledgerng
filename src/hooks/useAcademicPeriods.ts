import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type AcademicSession = Tables<"sessions">;
export type AcademicTerm = Tables<"terms">;

/** What the session dropdown renders: real DB sessions plus upcoming virtual ones. */
export interface SessionOption {
  id: string;
  name: string;
  isFuture?: boolean;
}

export const FUTURE_SESSION_COUNT = 10;
const FUTURE_ID_PREFIX = "future-";

export const isFutureSessionId = (id: string | undefined | null) =>
  !!id && id.startsWith(FUTURE_ID_PREFIX);

/**
 * Build the next `count` virtual sessions after the latest real session.
 * Virtual sessions exist only in the dropdown — they have no DB rows, so
 * nothing can be attached to them (that's what makes them non-editable).
 */
// Coerce a start/end year to a clean number. Prod's start_year/end_year columns
// drifted to text and hold dirty values ("2026", null, even "2025/2026"), so a
// raw `value + 1` would string-concatenate and produce gibberish upcoming
// sessions like "20270/20271". Numeric coercion + NaN guard keeps the math sane.
const toYear = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

export const buildFutureSessions = (
  sessions: Pick<AcademicSession, "name" | "start_year" | "end_year">[],
  currentYear: number,
  count: number = FUTURE_SESSION_COUNT
): SessionOption[] => {
  let lastEndYear = currentYear;
  for (const s of sessions) {
    // The name ("YYYY/YYYY") is the canonical value; prefer it over the drifted
    // year columns, falling back to those only when the name doesn't parse.
    const nameMatch = /^(\d{4})\s*\/\s*(\d{4})$/.exec((s.name || "").trim());
    const startCol = toYear(s.start_year);
    const end =
      (nameMatch ? Number(nameMatch[2]) : null) ??
      toYear(s.end_year) ??
      (startCol != null ? startCol + 1 : null);
    if (end != null && end > lastEndYear) lastEndYear = end;
  }
  const existingNames = new Set(sessions.map((s) => (s.name || "").trim()));
  const future: SessionOption[] = [];
  for (let i = 0; i < count; i++) {
    const start = lastEndYear + i;
    const name = `${start}/${start + 1}`;
    if (existingNames.has(name)) continue;
    future.push({ id: `${FUTURE_ID_PREFIX}${start}`, name, isFuture: true });
  }
  return future;
};

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
        const ay = toYear(a.start_year) ?? 0;
        const by = toYear(b.start_year) ?? 0;
        if (ay !== by) return by - ay;
        return (b.name || "").localeCompare(a.name || "");
      });
      setSelectedSessionId(sorted[0].id);
    }
  }, [sessions, selectedSessionId]);

  // When session changes, auto-select current term in that session, else Term 1.
  // Future (virtual) sessions have no terms — clear the term so nothing stale
  // leaks through period filters.
  useEffect(() => {
    if (!selectedSessionId) return;
    if (isFutureSessionId(selectedSessionId)) {
      setSelectedTermId("");
      return;
    }
    if (terms.length === 0) return;
    const sessionTerms = terms
      .filter((t) => t.session_id === selectedSessionId)
      .sort((a, b) => (a.term_number || 0) - (b.term_number || 0));
    const currentTerm = sessionTerms.find((t) => t.is_current);
    const defaultTerm = currentTerm || sessionTerms.find((t) => t.term_number === 1) || sessionTerms[0];
    if (defaultTerm) setSelectedTermId(defaultTerm.id);
  }, [selectedSessionId, terms]);

  const isFutureSession = isFutureSessionId(selectedSessionId);
  const futureSessions = buildFutureSessions(sessions, new Date().getFullYear());
  const sessionOptions: SessionOption[] = [
    ...sessions.map((s) => ({ id: s.id, name: s.name })),
    ...futureSessions,
  ];
  const selectedSession =
    sessions.find((s) => s.id === selectedSessionId) ??
    futureSessions.find((s) => s.id === selectedSessionId);
  const selectedTerm = terms.find((t) => t.id === selectedTermId);
  const termsForSelectedSession = isFutureSession
    ? []
    : terms
        .filter((t) => t.session_id === selectedSessionId)
        .sort((a, b) => (a.term_number || 0) - (b.term_number || 0));

  return {
    sessions,
    terms,
    sessionOptions,
    isFutureSession,
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
