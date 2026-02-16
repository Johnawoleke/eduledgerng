
-- Create class-level fees table
CREATE TABLE public.class_fees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  class_target TEXT NOT NULL, -- 'ALL', 'JSS1', 'JSS2', etc.
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  term TEXT NOT NULL DEFAULT '1st Term',
  session TEXT NOT NULL DEFAULT '2024/2025',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.class_fees ENABLE ROW LEVEL SECURITY;

-- School members can manage class fees
CREATE POLICY "School members can view class fees"
  ON public.class_fees FOR SELECT
  USING (is_school_member(school_id));

CREATE POLICY "School members can insert class fees"
  ON public.class_fees FOR INSERT
  WITH CHECK (is_school_member(school_id));

CREATE POLICY "School members can update class fees"
  ON public.class_fees FOR UPDATE
  USING (is_school_member(school_id));

CREATE POLICY "School members can delete class fees"
  ON public.class_fees FOR DELETE
  USING (is_school_member(school_id));
