
-- Drop triggers first, then function with CASCADE
DROP TRIGGER IF EXISTS hash_pin_before_insert ON public.students;
DROP TRIGGER IF EXISTS hash_pin_before_update ON public.students;
DROP TRIGGER IF EXISTS hash_pin_trigger ON public.students;
DROP FUNCTION IF EXISTS public.hash_student_pin() CASCADE;

-- Replace verify_student_pin with plain text comparison (no crypt/gen_salt)
DROP FUNCTION IF EXISTS public.verify_student_pin(uuid, text, text);

CREATE OR REPLACE FUNCTION public.verify_student_pin(p_school_id uuid, p_student_id text, p_pin text)
 RETURNS TABLE(id uuid, student_id text, name text, class text, term text, session text, school_id uuid, must_change_pin boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_student RECORD;
BEGIN
  SELECT s.* INTO v_student
  FROM public.students s
  WHERE s.school_id = p_school_id
    AND s.student_id = p_student_id;

  IF NOT FOUND THEN RETURN; END IF;

  IF v_student.locked_until IS NOT NULL AND v_student.locked_until > now() THEN RETURN; END IF;

  IF v_student.pin = p_pin THEN
    UPDATE public.students s SET failed_login_attempts = 0, locked_until = NULL WHERE s.id = v_student.id;
    RETURN QUERY SELECT v_student.id, v_student.student_id, v_student.name, v_student.class, v_student.term, v_student.session, v_student.school_id, v_student.must_change_pin;
  ELSE
    UPDATE public.students s
    SET failed_login_attempts = v_student.failed_login_attempts + 1,
        locked_until = CASE WHEN v_student.failed_login_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
    WHERE s.id = v_student.id;
    RETURN;
  END IF;
END;
$function$;
