import React, { useEffect, useState } from "react";
import { Bell, Volume2, VolumeX, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNotifications } from "@/hooks/useNotifications";

const SOUND_PREF_KEY = "eduledger_notif_sound";

// "3m ago" / "2h ago" / "Jul 21" — compact, no dependency.
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface NotificationBellProps {
  schoolId: string | null | undefined;
}

const NotificationBell: React.FC<NotificationBellProps> = ({ schoolId }) => {
  const [soundOn, setSoundOn] = useState(true);
  const [open, setOpen] = useState(false);

  // Load the persisted sound preference once.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SOUND_PREF_KEY);
      if (saved !== null) setSoundOn(saved === "true");
    } catch {
      /* ignore */
    }
  }, []);

  const toggleSound = () => {
    setSoundOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SOUND_PREF_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const { notifications, unreadCount, markAllRead } = useNotifications(schoolId, soundOn);

  // Mark everything read when the panel is opened.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && unreadCount > 0) markAllRead();
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative h-9 w-9 p-0"
          title="Notifications"
          aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold leading-4 text-center">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-semibold">Notifications</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={toggleSound}
              title={soundOn ? "Sound on" : "Sound off"}
              aria-label={soundOn ? "Turn notification sound off" : "Turn notification sound on"}
            >
              {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4 text-muted-foreground" />}
            </Button>
            {notifications.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={markAllRead}
                title="Mark all read"
                aria-label="Mark all read"
              >
                <CheckCheck className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>

        {notifications.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No notifications yet. You'll be alerted here when a student pays.
          </div>
        ) : (
          <ScrollArea className="max-h-80">
            <ul className="divide-y">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`px-3 py-2.5 ${n.read_at ? "" : "bg-primary/5"}`}
                >
                  <div className="flex items-start gap-2">
                    {!n.read_at && (
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium leading-tight">{n.title}</p>
                      {n.body && (
                        <p className="text-xs text-muted-foreground mt-0.5 break-words">{n.body}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground mt-1">{relativeTime(n.created_at)}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default NotificationBell;
