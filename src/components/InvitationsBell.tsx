// A self-contained pending-invitations indicator for any signed-in staff page.
// Shows a bell + count in the header; clicking opens a dialog to accept/decline.
// Data is fetched independently, so it works on every authenticated page
// (the main dashboard has its own richer version; this closes the gap on the
// school admin dashboard and anywhere else it's dropped in).
import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Bell, Check, X, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionsError } from "@/lib/utils";

interface Invite {
  id: string;
  role: string;
  expires_at: string;
  school: { name: string; slug: string } | null;
}

const InvitationsBell = () => {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [open, setOpen] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("school_requests")
      .select("id, role, expires_at, schools(name, slug)")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .gte("expires_at", new Date().toISOString());
    type Row = {
      id: string; role: string; expires_at: string;
      schools: { name: string; slug: string } | { name: string; slug: string }[] | null;
    };
    setInvites(
      ((data as Row[] | null) || []).map((r) => {
        const school = Array.isArray(r.schools) ? r.schools[0] ?? null : r.schools;
        return { id: r.id, role: r.role, expires_at: r.expires_at, school };
      })
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (invite: Invite, action: "accept" | "decline") => {
    setProcessingId(invite.id);
    try {
      const { data, error } = await supabase.functions.invoke("handle-school-request", {
        body: { requestId: invite.id, action },
      });
      if (error || data?.error) {
        toast.error(data?.error || (await readFunctionsError(error, "Failed to process invitation")));
        return;
      }
      if (action === "accept") {
        toast.success(`You now have access to ${invite.school?.name || "the school"}.`);
      } else {
        toast.success("Invitation declined.");
      }
      const remaining = invites.filter((i) => i.id !== invite.id);
      setInvites(remaining);
      if (remaining.length === 0) setOpen(false);
    } finally {
      setProcessingId(null);
    }
  };

  if (invites.length === 0) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title="Pending invitations"
        className="relative"
      >
        <Bell className="w-4 h-4" />
        <Badge
          variant="destructive"
          className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] flex items-center justify-center"
        >
          {invites.length}
        </Badge>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary" /> School Invitations
            </DialogTitle>
            <DialogDescription>
              You've been invited to join the following school(s). Accept or decline each.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 max-h-[55vh] overflow-y-auto">
            {invites.map((invite) => (
              <div key={invite.id} className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <p className="font-semibold">{invite.school?.name || "A school"}</p>
                <p className="text-sm text-muted-foreground">
                  Role: <span className="capitalize font-medium">{invite.role}</span>
                </p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                  <Clock className="w-3 h-3" />
                  Expires {new Date(invite.expires_at).toLocaleDateString()}
                </div>
                <div className="flex gap-2 mt-3">
                  <Button
                    size="sm"
                    className="gap-1 flex-1"
                    onClick={() => act(invite, "accept")}
                    disabled={processingId === invite.id}
                  >
                    {processingId === invite.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="gap-1 flex-1"
                    onClick={() => act(invite, "decline")}
                    disabled={processingId === invite.id}
                  >
                    <X className="w-4 h-4" /> Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default InvitationsBell;
