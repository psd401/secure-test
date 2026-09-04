"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { ACCOMMODATION_CATALOG } from "@/lib/accommodations/catalog";
import type { PendingTideDiff } from "@/lib/accommodations/pendingDiffs";
import { ApiError, accommodationErrorCopy } from "@/lib/ui/errorCopy";
import { studentHeading } from "@/lib/ui/format";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/app/EmptyState";

interface Props {
  rows: PendingTideDiff[];
}

async function readError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // not JSON
  }
  return new ApiError(code, res.status);
}

export function DiffReviewPanel({ rows }: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // UX pass 2 slice 5 (P2-5): "Keep mine" now persists — the server stores
  // the TIDE code the teacher decided against, so the identical next import
  // does not re-raise the conflict. The local set keeps the row hidden
  // optimistically while the refresh runs.
  const [kept, setKept] = useState<Set<string>>(new Set());

  const labelById = useMemo(() => new Map(ACCOMMODATION_CATALOG.map((e) => [e.id, e.label])), []);

  // D13/D14: this used to be a free-text box the teacher hand-typed TIDE's
  // value into, and the API stored whatever arrived as canonical `tide_import`
  // provenance — so a typo became "TIDE truth" in the audit ledger. The value
  // now comes from the row's own tide_code, and the API re-derives it from the
  // catalog before writing.
  async function useTide(accId: string, tide_value: string) {
    setBusyId(accId);
    setError(null);
    try {
      const res = await fetch(`/api/accommodations/import/diff/${accId}/accept-tide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tide_value }),
      });
      if (!res.ok) throw await readError(res);
      router.refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "network";
      const copy = accommodationErrorCopy(code);
      setError(copy.showCode ? `${copy.message} ${code}` : copy.message);
    } finally {
      setBusyId(null);
    }
  }

  async function keepMine(accId: string) {
    setBusyId(accId);
    setError(null);
    try {
      const res = await fetch(`/api/accommodations/import/diff/${accId}/keep-mine`, {
        method: "POST",
      });
      if (!res.ok) throw await readError(res);
      setKept((prev) => new Set(prev).add(accId));
      router.refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "network";
      const copy = accommodationErrorCopy(code);
      setError(copy.showCode ? `${copy.message} ${code}` : copy.message);
    } finally {
      setBusyId(null);
    }
  }

  const visible = rows.filter((r) => !kept.has(r.accommodation_id));

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 />}
        title="Nothing to review"
        description="Every setting agrees with TIDE, or you've decided. The next import raises anything new."
        action={
          <Button asChild variant="outline">
            <Link href="/dashboard/accommodations">Back to Students</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Setting</TableHead>
              <TableHead>Your value</TableHead>
              <TableHead>TIDE value</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Decide</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => (
              <TableRow key={r.accommodation_id}>
                <TableCell>
                  <Link href={`/dashboard/accommodations/${r.student_id}`} className="font-medium hover:underline">
                    {studentHeading({ name: r.student_name, ssid: r.ssid })}
                  </Link>
                  <div className="text-xs text-muted-foreground">SSID {r.ssid ?? "—"}</div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{labelById.get(r.tool_id) ?? r.tool_id}</div>
                  <div className="text-xs text-muted-foreground">{r.subject}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="success">{r.kept_value}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{r.tide_value}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <span className="inline-flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busyId === r.accommodation_id}
                      onClick={() => useTide(r.accommodation_id, r.tide_value)}
                    >
                      {busyId === r.accommodation_id ? "Saving…" : "Use TIDE value"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === r.accommodation_id}
                      onClick={() => keepMine(r.accommodation_id)}
                    >
                      Keep mine
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
