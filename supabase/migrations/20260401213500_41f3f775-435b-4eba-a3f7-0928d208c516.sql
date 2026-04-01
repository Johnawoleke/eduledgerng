
CREATE TABLE public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text,
  payment_id text,
  status text,
  amount_usd numeric,
  payload jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "School members can view payment events"
  ON public.payment_events FOR SELECT TO authenticated
  USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.payment_events;
