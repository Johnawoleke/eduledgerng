
-- 1. Add start_year, end_year to academic_sessions
ALTER TABLE public.academic_sessions ADD COLUMN IF NOT EXISTS start_year integer;
ALTER TABLE public.academic_sessions ADD COLUMN IF NOT EXISTS end_year integer;

-- 2. Add term_number to academic_terms
ALTER TABLE public.academic_terms ADD COLUMN IF NOT EXISTS term_number integer;

-- 3. Populate start_year/end_year from existing name patterns like "2024/2025"
UPDATE public.academic_sessions
SET start_year = CAST(split_part(name, '/', 1) AS integer),
    end_year = CAST(split_part(name, '/', 2) AS integer)
WHERE name ~ '^\d{4}/\d{4}$' AND start_year IS NULL;

-- 4. Populate term_number from term name
UPDATE public.academic_terms SET term_number = 1 WHERE name = 'Term 1' AND term_number IS NULL;
UPDATE public.academic_terms SET term_number = 2 WHERE name = 'Term 2' AND term_number IS NULL;
UPDATE public.academic_terms SET term_number = 3 WHERE name = 'Term 3' AND term_number IS NULL;

-- 5. Migrate orphaned class_fees (no session_id/term_id) to default session+term
-- Find or use the earliest session per school, Term 1
UPDATE public.class_fees cf
SET session_id = sub.session_id, term_id = sub.term_id
FROM (
  SELECT DISTINCT ON (s.school_id)
    s.id AS session_id,
    t.id AS term_id,
    s.school_id
  FROM public.academic_sessions s
  JOIN public.academic_terms t ON t.session_id = s.id AND t.name = 'Term 1'
  ORDER BY s.school_id, s.name ASC
) sub
WHERE cf.session_id IS NULL AND cf.school_id = sub.school_id;

-- 6. Migrate orphaned payments to default session+term
UPDATE public.payments p
SET session_id = sub.session_id, term_id = sub.term_id
FROM (
  SELECT DISTINCT ON (s.school_id)
    s.id AS session_id,
    t.id AS term_id,
    s.school_id
  FROM public.academic_sessions s
  JOIN public.academic_terms t ON t.session_id = s.id AND t.name = 'Term 1'
  ORDER BY s.school_id, s.name ASC
) sub
WHERE p.session_id IS NULL AND p.school_id = sub.school_id;

-- 7. Drop is_current columns (no longer needed for pure filtering)
ALTER TABLE public.academic_sessions DROP COLUMN IF EXISTS is_current;
ALTER TABLE public.academic_terms DROP COLUMN IF EXISTS is_current;

-- 8. Drop triggers related to is_current switching
DROP TRIGGER IF EXISTS ensure_single_current_session_trigger ON public.academic_sessions;
DROP TRIGGER IF EXISTS ensure_single_current_term_trigger ON public.academic_terms;

-- 9. Drop the is_current functions
DROP FUNCTION IF EXISTS public.ensure_single_current_session() CASCADE;
DROP FUNCTION IF EXISTS public.ensure_single_current_term() CASCADE;

-- 10. Update the create_default_session trigger function (remove is_current references)
CREATE OR REPLACE FUNCTION public.create_default_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session_id UUID;
  v_start_year integer;
  v_end_year integer;
  v_year integer;
BEGIN
  v_year := EXTRACT(YEAR FROM now())::integer;
  
  FOR i IN 0..2 LOOP
    v_start_year := v_year - 1 + i;
    v_end_year := v_start_year + 1;
    
    INSERT INTO public.academic_sessions (school_id, name, start_year, end_year)
    VALUES (NEW.id, v_start_year || '/' || v_end_year, v_start_year, v_end_year)
    RETURNING id INTO v_session_id;

    INSERT INTO public.academic_terms (session_id, school_id, name, term_number) VALUES
      (v_session_id, NEW.id, 'Term 1', 1),
      (v_session_id, NEW.id, 'Term 2', 2),
      (v_session_id, NEW.id, 'Term 3', 3);
  END LOOP;

  RETURN NEW;
END;
$function$;
