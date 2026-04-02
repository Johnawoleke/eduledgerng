
-- Remove duplicate sessions: keep the oldest one per school_id+name
DELETE FROM public.academic_terms
WHERE session_id IN (
  SELECT id FROM public.academic_sessions
  WHERE id NOT IN (
    SELECT DISTINCT ON (school_id, name) id
    FROM public.academic_sessions
    ORDER BY school_id, name, created_at ASC
  )
);

DELETE FROM public.academic_sessions
WHERE id NOT IN (
  SELECT DISTINCT ON (school_id, name) id
  FROM public.academic_sessions
  ORDER BY school_id, name, created_at ASC
);

-- Add unique indexes to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS sessions_school_name_uniq ON public.academic_sessions(school_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS terms_session_number_uniq ON public.academic_terms(session_id, term_number);
