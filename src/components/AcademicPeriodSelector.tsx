import React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { AcademicSession, AcademicTerm } from "@/hooks/useAcademicPeriods";

interface Props {
  sessions: AcademicSession[];
  termsForSelectedSession: AcademicTerm[];
  selectedSessionId: string;
  selectedTermId: string;
  onSessionChange: (id: string) => void;
  onTermChange: (id: string) => void;
  compact?: boolean;
}

const AcademicPeriodSelector: React.FC<Props> = ({
  sessions,
  termsForSelectedSession,
  selectedSessionId,
  selectedTermId,
  onSessionChange,
  onTermChange,
  compact = false,
}) => {
  return (
    <div className={`flex ${compact ? "flex-row gap-2" : "flex-col sm:flex-row gap-3"}`}>
      <div className={compact ? "flex-1" : "space-y-1 flex-1"}>
        {!compact && <Label className="text-xs text-muted-foreground">Session</Label>}
        <Select value={selectedSessionId} onValueChange={onSessionChange}>
          <SelectTrigger className={compact ? "h-9" : ""}>
            <SelectValue placeholder="Select session" />
          </SelectTrigger>
          <SelectContent>
            {sessions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className={compact ? "flex-1" : "space-y-1 flex-1"}>
        {!compact && <Label className="text-xs text-muted-foreground">Term</Label>}
        <Select value={selectedTermId} onValueChange={onTermChange}>
          <SelectTrigger className={compact ? "h-9" : ""}>
            <SelectValue placeholder="Select term" />
          </SelectTrigger>
          <SelectContent>
            {termsForSelectedSession.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};

export default AcademicPeriodSelector;