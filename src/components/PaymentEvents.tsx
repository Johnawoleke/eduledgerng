import { usePaymentEvents } from "@/hooks/usePaymentEvents";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function statusVariant(status: string | null): "default" | "destructive" | "secondary" | "outline" {
  if (!status) return "outline";
  const s = status.toLowerCase();
  if (s === "confirmed" || s === "succeeded" || s === "successful" || s === "completed") return "default";
  if (s === "failed" || s === "expired") return "destructive";
  return "secondary";
}

function statusColor(status: string | null): string {
  if (!status) return "bg-muted text-muted-foreground";
  const s = status.toLowerCase();
  if (s === "confirmed" || s === "succeeded" || s === "successful" || s === "completed")
    return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
  if (s === "failed" || s === "expired")
    return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
  return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
}

export default function PaymentEvents() {
  const { events, loading } = usePaymentEvents();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Payment Events
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
          </span>
          <span className="text-xs font-normal text-muted-foreground">Live</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading events...</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payment events yet.</p>
        ) : (
          <div className="overflow-auto max-h-96">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Payment ID</TableHead>
                  <TableHead>Amount (USD)</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs">{e.event_type || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{e.payment_id || "—"}</TableCell>
                    <TableCell>{e.amount_usd != null ? `$${Number(e.amount_usd).toFixed(2)}` : "—"}</TableCell>
                    <TableCell>
                      <Badge className={statusColor(e.status)}>{e.status || "unknown"}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(e.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
