
-- Add school_code to schools for generating student IDs
ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS school_code text;

-- Add must_change_pin to students for first-login PIN change
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS must_change_pin boolean NOT NULL DEFAULT true;

-- Add default_pin to students to show admin the original generated PIN
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS default_pin text;
