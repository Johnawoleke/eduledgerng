
-- Create academic_sessions table
CREATE TABLE public.academic_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create academic_terms table
CREATE TABLE public.academic_terms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.academic_sessions(id) ON DELETE CASCADE,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add session_id and term_id to class_fees (nullable for backward compat)
ALTER TABLE public.class_fees
  ADD COLUMN session_id UUID REFERENCES public.academic_sessions(id) ON DELETE SET NULL,
  ADD COLUMN term_id UUID REFERENCES public.academic_terms(id) ON DELETE SET NULL;

-- Enable RLS
ALTER TABLE public.academic_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.academic_terms ENABLE ROW LEVEL SECURITY;

-- RLS for academic_sessions
CREATE POLICY "School members can view sessions" ON public.academic_sessions
  FOR SELECT TO public USING (is_school_member(school_id));
CREATE POLICY "School members can insert sessions" ON public.academic_sessions
  FOR INSERT TO public WITH CHECK (is_school_member(school_id));
CREATE POLICY "School members can update sessions" ON public.academic_sessions
  FOR UPDATE TO public USING (is_school_member(school_id));
CREATE POLICY "School members can delete sessions" ON public.academic_sessions
  FOR DELETE TO public USING (is_school_member(school_id));

-- RLS for academic_terms
CREATE POLICY "School members can view terms" ON public.academic_terms
  FOR SELECT TO public USING (is_school_member(school_id));
CREATE POLICY "School members can insert terms" ON public.academic_terms
  FOR INSERT TO public WITH CHECK (is_school_member(school_id));
CREATE POLICY "School members can update terms" ON public.academic_terms
  FOR UPDATE TO public USING (is_school_member(school_id));
CREATE POLICY "School members can delete terms" ON public.academic_terms
  FOR DELETE TO public USING (is_school_member(school_id));

-- Function to auto-create default session when school is created
CREATE OR REPLACE FUNCTION public.create_default_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_session_id UUID;
BEGIN
  INSERT INTO public.academic_sessions (school_id, name, is_current)
  VALUES (NEW.id, '2025/2026', true)
  RETURNING id INTO v_session_id;

  INSERT INTO public.academic_terms (session_id, school_id, name, is_current) VALUES
    (v_session_id, NEW.id, 'Term 1', true),
    (v_session_id, NEW.id, 'Term 2', false),
    (v_session_id, NEW.id, 'Term 3', false);

  RETURN NEW;
END;
$$;

-- Trigger on school creation
CREATE TRIGGER on_school_created_create_session
  AFTER INSERT ON public.schools
  FOR EACH ROW
  EXECUTE FUNCTION public.create_default_session();

-- Ensure only one current session per school
CREATE OR REPLACE FUNCTION public.ensure_single_current_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.is_current = true THEN
    UPDATE public.academic_sessions
    SET is_current = false
    WHERE school_id = NEW.school_id AND id != NEW.id AND is_current = true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ensure_single_current_session_trigger
  BEFORE INSERT OR UPDATE ON public.academic_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_single_current_session();

-- Ensure only one current term per session
CREATE OR REPLACE FUNCTION public.ensure_single_current_term()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.is_current = true THEN
    UPDATE public.academic_terms
    SET is_current = false
    WHERE session_id = NEW.session_id AND id != NEW.id AND is_current = true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ensure_single_current_term_trigger
  BEFORE INSERT OR UPDATE ON public.academic_terms
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_single_current_term();
