// Creating an academic session, in one place.
//
// A session is useless without terms: a fee is keyed to a term, so a session
// with none can never hold a fee. That pairing was previously written out twice
// — once in useAcademicPeriods' first-session seeding, once in the rollover's
// "create the year I am promoting into" path — and the second copy shipped
// without the terms, so a school could have promoted its whole roster into a
// year it could never bill for.
//
// That is the same duplication shape that produced the legacy-payment bug in
// _shared/ledger.ts. One function, both callers.

import { supabase } from "@/integrations/supabase/client";

export interface CreatedSession {
  id: string;
  name: string;
}

export interface CreateSessionResult {
  session: CreatedSession | null;
  /** Human-readable reason, already suitable for a toast. */
  error: string | null;
}

/** The three terms every Nigerian session has, in order. */
export const DEFAULT_TERMS = ["Term 1", "Term 2", "Term 3"] as const;

/**
 * Make sure a session that already exists has terms.
 *
 * Sessions created before session-and-terms became one operation can have none
 * — 21 of 52 on production did — and a session with no terms can never hold a
 * fee. Promoting a whole school into one leaves it unable to bill for the year,
 * with nothing on screen to explain why.
 *
 * Returns null when nothing was needed.
 */
export const ensureSessionHasTerms = async (
  schoolId: string,
  sessionId: string
): Promise<string | null> => {
  const { data: existing, error } = await supabase
    .from("terms")
    .select("id")
    .eq("session_id", sessionId)
    .limit(1);

  if (error) return error.message;
  if (existing && existing.length > 0) return null;

  const { error: insertError } = await supabase.from("terms").insert(
    DEFAULT_TERMS.map((termName, i) => ({
      session_id: sessionId,
      school_id: schoolId,
      name: termName,
      term_number: i + 1,
      is_current: i === 0,
    }))
  );
  return insertError?.message ?? null;
};

/**
 * Create a session AND its terms.
 *
 * Returns an error rather than a half-built session: one that exists without
 * terms is worse than none at all, because it shows up in every picker and
 * silently cannot hold a fee.
 *
 * Requires an authenticated school member — sessions/terms INSERT is
 * member-scoped by RLS, so this no-ops for students by design.
 */
export const createSessionWithTerms = async (
  schoolId: string,
  name: string,
  opts: { startYear?: number | null; isCurrent?: boolean } = {}
): Promise<CreateSessionResult> => {
  const parsed = Number(String(name).slice(0, 4));
  const startYear = opts.startYear ?? (Number.isFinite(parsed) ? parsed : null);

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      school_id: schoolId,
      name,
      start_year: startYear,
      end_year: startYear != null ? startYear + 1 : null,
      is_current: opts.isCurrent ?? false,
    })
    .select("id, name")
    .single();

  if (sessionError || !session) {
    return { session: null, error: sessionError?.message || `Could not create the ${name} session.` };
  }

  const { error: termsError } = await supabase.from("terms").insert(
    DEFAULT_TERMS.map((termName, i) => ({
      session_id: session.id,
      school_id: schoolId,
      name: termName,
      term_number: i + 1,
      is_current: i === 0,
    }))
  );

  if (termsError) {
    return {
      session: null,
      error: `Created ${name}, but its terms could not be added: ${termsError.message}`,
    };
  }

  return { session, error: null };
};
