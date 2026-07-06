
-- Add session_id and term_id to payments table
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.academic_sessions(id);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS term_id uuid REFERENCES public.academic_terms(id);

-- Drop the create_default_session trigger and recreate with auto-generated sessions
-- We'll auto-generate sessions 2024/2025, 2025/2026, 2026/2027 on school creation
DROP TRIGGER IF EXISTS on_school_created ON public.schools;

CREATE OR REPLACE FUNCTION public.create_default_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session_id UUID;
  v_sessions text[] := ARRAY['2024/2025', '2025/2026', '2026/2027'];
  v_session_name text;
BEGIN
  FOREACH v_session_name IN ARRAY v_sessions
  LOOP
    INSERT INTO public.academic_sessions (school_id, name, is_current)
    VALUES (NEW.id, v_session_name, false)
    RETURNING id INTO v_session_id;

    INSERT INTO public.academic_terms (session_id, school_id, name, is_current) VALUES
      (v_session_id, NEW.id, 'Term 1', false),
      (v_session_id, NEW.id, 'Term 2', false),
      (v_session_id, NEW.id, 'Term 3', false);
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER on_school_created
  AFTER INSERT ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.create_default_session();
