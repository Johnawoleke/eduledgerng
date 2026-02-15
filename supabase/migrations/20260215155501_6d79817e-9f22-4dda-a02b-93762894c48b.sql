
-- Schools table
CREATE TABLE public.schools (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  address TEXT,
  phone TEXT,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;

-- School admins (additional admins beyond owner)
CREATE TABLE public.school_admins (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(school_id, user_id)
);

ALTER TABLE public.school_admins ENABLE ROW LEVEL SECURITY;

-- Students table (no auth account needed - they use ID+PIN)
CREATE TABLE public.students (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL, -- e.g. EDU/2024/001
  name TEXT NOT NULL,
  class TEXT NOT NULL,
  term TEXT NOT NULL DEFAULT '1st Term',
  session TEXT NOT NULL DEFAULT '2024/2025',
  pin TEXT NOT NULL, -- will be hashed later
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(school_id, student_id)
);

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

-- Fee items per student
CREATE TABLE public.fee_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  paid NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid', 'partial', 'unpaid')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.fee_items ENABLE ROW LEVEL SECURITY;

-- Payments
CREATE TABLE public.payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  reference TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'Paystack',
  items TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- Helper function: check if user is school owner or admin
CREATE OR REPLACE FUNCTION public.is_school_member(school_id_param UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.schools WHERE id = school_id_param AND owner_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.school_admins WHERE school_id = school_id_param AND user_id = auth.uid()
  )
$$;

-- Schools policies
CREATE POLICY "Anyone can read schools by slug" ON public.schools FOR SELECT USING (true);
CREATE POLICY "Owners can insert schools" ON public.schools FOR INSERT WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Owners can update their schools" ON public.schools FOR UPDATE USING (owner_id = auth.uid());
CREATE POLICY "Owners can delete their schools" ON public.schools FOR DELETE USING (owner_id = auth.uid());

-- School admins policies
CREATE POLICY "School members can view admins" ON public.school_admins FOR SELECT USING (public.is_school_member(school_id));
CREATE POLICY "School owners can manage admins" ON public.school_admins FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.schools WHERE id = school_id AND owner_id = auth.uid())
);
CREATE POLICY "School owners can delete admins" ON public.school_admins FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.schools WHERE id = school_id AND owner_id = auth.uid())
);

-- Students policies (admin access - student access via edge function)
CREATE POLICY "School members can view students" ON public.students FOR SELECT USING (public.is_school_member(school_id));
CREATE POLICY "School members can insert students" ON public.students FOR INSERT WITH CHECK (public.is_school_member(school_id));
CREATE POLICY "School members can update students" ON public.students FOR UPDATE USING (public.is_school_member(school_id));
CREATE POLICY "School members can delete students" ON public.students FOR DELETE USING (public.is_school_member(school_id));

-- Fee items policies
CREATE POLICY "School members can view fee items" ON public.fee_items FOR SELECT USING (public.is_school_member(school_id));
CREATE POLICY "School members can insert fee items" ON public.fee_items FOR INSERT WITH CHECK (public.is_school_member(school_id));
CREATE POLICY "School members can update fee items" ON public.fee_items FOR UPDATE USING (public.is_school_member(school_id));
CREATE POLICY "School members can delete fee items" ON public.fee_items FOR DELETE USING (public.is_school_member(school_id));

-- Payments policies
CREATE POLICY "School members can view payments" ON public.payments FOR SELECT USING (public.is_school_member(school_id));
CREATE POLICY "School members can insert payments" ON public.payments FOR INSERT WITH CHECK (public.is_school_member(school_id));

-- Profiles table for school owners
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (user_id = auth.uid());

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'full_name');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Update timestamp triggers
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_schools_updated_at BEFORE UPDATE ON public.schools FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER update_students_updated_at BEFORE UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
