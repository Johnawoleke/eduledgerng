
-- Enable pgcrypto for password hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Add rate limiting columns to students
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamp with time zone;

-- Create trigger function to auto-hash PINs on insert/update
CREATE OR REPLACE FUNCTION public.hash_student_pin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Only hash if pin is being set and is not already hashed (bcrypt hashes start with $2)
  IF NEW.pin IS NOT NULL AND NEW.pin != '' AND LEFT(NEW.pin, 2) != '$2' THEN
    NEW.pin := crypt(NEW.pin, gen_salt('bf', 8));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hash_pin_before_insert
  BEFORE INSERT ON public.students
  FOR EACH ROW
  EXECUTE FUNCTION public.hash_student_pin();

CREATE TRIGGER hash_pin_before_update
  BEFORE UPDATE OF pin ON public.students
  FOR EACH ROW
  EXECUTE FUNCTION public.hash_student_pin();

-- Migrate existing plaintext PINs to hashed format
UPDATE public.students
SET pin = crypt(pin, gen_salt('bf', 8))
WHERE LEFT(pin, 2) != '$2';

-- Create a verify_student_pin function for edge functions to use
CREATE OR REPLACE FUNCTION public.verify_student_pin(
  p_school_id uuid,
  p_student_id text,
  p_pin text
)
RETURNS TABLE(
  id uuid,
  student_id text,
  name text,
  class text,
  term text,
  session text,
  school_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_student RECORD;
BEGIN
  -- Find student and check lockout
  SELECT s.* INTO v_student
  FROM public.students s
  WHERE s.school_id = p_school_id
    AND s.student_id = p_student_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Check if account is locked
  IF v_student.locked_until IS NOT NULL AND v_student.locked_until > now() THEN
    RETURN;
  END IF;

  -- Verify PIN using crypt comparison
  IF v_student.pin = crypt(p_pin, v_student.pin) THEN
    -- Reset failed attempts on success
    UPDATE public.students s
    SET failed_login_attempts = 0, locked_until = NULL
    WHERE s.id = v_student.id;

    RETURN QUERY
    SELECT v_student.id, v_student.student_id, v_student.name, 
           v_student.class, v_student.term, v_student.session, v_student.school_id;
  ELSE
    -- Increment failed attempts
    UPDATE public.students s
    SET failed_login_attempts = v_student.failed_login_attempts + 1,
        locked_until = CASE 
          WHEN v_student.failed_login_attempts + 1 >= 5 
          THEN now() + interval '15 minutes'
          ELSE NULL 
        END
    WHERE s.id = v_student.id;

    RETURN;
  END IF;
END;
$$;
