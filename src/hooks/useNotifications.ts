import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AppNotification {
  id: string;
  school_id: string;
  type: string;
  title: string;
  body: string | null;
  reference: string | null;
  amount: number | null;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

// A short two-note chime synthesized with the Web Audio API — avoids shipping an
// audio asset and sidesteps autoplay policy (it only ever plays in response to a
// realtime event that arrives while the admin is actively using the dashboard).
function playChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notes = [
      { freq: 880, at: 0 },
      { freq: 1174.66, at: 0.12 },
    ];
    for (const { freq, at } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const start = now + at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.start(start);
      osc.stop(start + 0.3);
    }
    // Release the context shortly after the sound finishes.
    window.setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch {
    /* audio is best-effort; never let it break the UI */
  }
}

/**
 * Live notification feed for one school. Loads the most recent notifications,
 * then subscribes to realtime inserts (RLS restricts these to the school's
 * owner + bursars). New arrivals play a chime and bump the unread count.
 *
 * @param schoolId  the school whose notifications to watch (falsy = inactive)
 * @param soundOn   whether to play the chime on new arrivals (default true)
 */
export function useNotifications(schoolId: string | null | undefined, soundOn = true) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  const unreadCount = notifications.reduce((n, x) => n + (x.read_at ? 0 : 1), 0);

  useEffect(() => {
    if (!schoolId) {
      setNotifications([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);

    supabase
      .from("notifications")
      .select("*")
      .eq("school_id", schoolId)
      .order("created_at", { ascending: false })
      .limit(30)
      .then(({ data }) => {
        if (!active) return;
        if (data) setNotifications(data as AppNotification[]);
        setLoading(false);
      });

    const channel = supabase
      .channel(`notifications:${schoolId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `school_id=eq.${schoolId}`,
        },
        (payload) => {
          const row = payload.new as AppNotification;
          setNotifications((prev) =>
            prev.some((n) => n.id === row.id) ? prev : [row, ...prev].slice(0, 50),
          );
          if (soundRef.current) playChime();
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [schoolId]);

  const markAllRead = useCallback(async () => {
    const unreadIds = notifications.filter((n) => !n.read_at).map((n) => n.id);
    if (unreadIds.length === 0) return;
    const stamp = new Date().toISOString();
    // Optimistic — the realtime feed won't echo UPDATEs back to us.
    setNotifications((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: stamp })));
    await supabase.from("notifications").update({ read_at: stamp }).in("id", unreadIds);
  }, [notifications]);

  return { notifications, unreadCount, loading, markAllRead };
}
