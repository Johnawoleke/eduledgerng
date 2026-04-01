import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface PaymentEvent {
  id: string;
  event_type: string | null;
  payment_id: string | null;
  status: string | null;
  amount_usd: number | null;
  payload: any;
  created_at: string;
}

export function usePaymentEvents() {
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch existing events
    supabase
      .from("payment_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (data) setEvents(data as PaymentEvent[]);
        setLoading(false);
      });

    // Subscribe to realtime inserts
    const channel = supabase
      .channel("payment_events_realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "payment_events" },
        (payload) => {
          setEvents((prev) => [payload.new as PaymentEvent, ...prev]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return { events, loading };
}
