"use client";

// Slice 87: one sitting, live. Same endpoint and cadence as the Sittings tab
// (docs/phase-7-slices.md, monitor v2), laid out for a teacher watching a
// room rather than editing an assessment.
//
// UX pass 1, slice 7 (SM-05/10/11/13/14/20): the header renders from the
// server's row before the first fetch; polling keeps going through a failed
// poll (the rows stay, the LiveIndicator says they are stale); five tiles
// triage the room and filter the table; a sticky alert reads as "Needs
// attention" only until the student is back at work, then as history; the
// peek is a real dialog. The attendance transport and the peek lifecycle
// (delete-on-read, discard-on-close) are unchanged.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownAZ, ListOrdered, Monitor, Presentation, ScanEye } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/app/EmptyState";
import { LiveIndicator } from "@/components/app/LiveIndicator";
import { MonitorSummary, SUMMARY_ORDER } from "@/components/app/MonitorSummary";
import { PageHeader } from "@/components/app/PageHeader";
import { ProgressBar } from "@/components/app/ProgressBar";
import { SessionCode } from "@/components/app/SessionCode";
import { ShowCodeDialog } from "@/components/app/ShowCodeDialog";
import {
  SessionStatusBadge,
  StudentStatusBadge,
  sessionState,
  type StudentState,
} from "@/components/app/StatusBadge";
import { DeleteAttemptControl } from "@/components/app/DeleteAttemptControl";
import { HandInAttemptControl } from "@/components/app/HandInAttemptControl";
import { ViewScreenDialog } from "@/components/app/ViewScreenDialog";
import { ApiError, sessionErrorCopy } from "@/lib/ui/errorCopy";
import { closesAt } from "@/lib/ui/format";
import { cn } from "@/lib/utils";
import {
  LIVE_INTERVAL_MS,
  ago,
  alertIsCurrent,
  eventLabel,
  idleFor,
  studentState,
  type AttendancePayload,
  type AttendanceRow,
} from "../../attendanceView";

interface Props {
  assessmentId: string;
  assessmentName: string;
  sittingId: string;
  /** From the server row, so the header paints before the first fetch (SM-05). */
  code: string;
  status: string;
  expiresAt: string;
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

function describe(e: unknown): string {
  const code = e instanceof ApiError ? e.code : "network";
  const copy = sessionErrorCopy(code);
  return copy.showCode ? `${copy.message} ${code}` : copy.message;
}

const EMPTY_COUNTS: Record<StudentState, number> = {
  needs_attention: 0,
  idle: 0,
  in_progress: 0,
  not_joined: 0,
  handed_in: 0,
};

export function MonitorView({ assessmentId, assessmentName, sittingId, code, status, expiresAt }: Props) {
  const [data, setData] = useState<AttendancePayload | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pollFailedAt, setPollFailedAt] = useState<Date | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const [filter, setFilter] = useState<StudentState | null>(null);
  const [sort, setSort] = useState<"triage" | "name">("triage");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/test-sessions/${sittingId}/attendance`);
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as AttendancePayload;
      setData(body);
      setFetchedAt(Date.now());
      setNow(Date.now());
      setPollFailedAt(null);
    } catch {
      // Keep the last rows on screen; the LiveIndicator reports the stale
      // snapshot and the next tick retries.
      setPollFailedAt(new Date());
      setNow(Date.now());
    }
  }, [sittingId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Server props first, the live payload once it arrives — so `open` (and
  // therefore polling) never depends on a fetch having succeeded.
  const session = data?.test_session ?? { status, expires_at: expiresAt };
  const state = sessionState(session, now);
  const open = state === "open";
  // UX pass 2 slice 4 (P2-8): a Closed session promises "students already in
  // can finish" — keep polling while any of them is still working.
  const anyStillWorking = (data?.rows ?? []).some((r) => r.status === "in_progress");
  const polling = open || anyStillWorking;

  useEffect(() => {
    if (!polling) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      void load();
    };
    const start = () => {
      if (timer === null) timer = setInterval(tick, LIVE_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        tick();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [polling, load]);

  async function confirmClose() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/test-sessions/${sittingId}/close`, { method: "POST" });
      if (!res.ok) throw await readError(res);
      await load();
    } catch (err) {
      setActionError(describe(err));
    } finally {
      setBusy(false);
      setPendingClose(false);
    }
  }

  const rows = useMemo(() => {
    const list = (data?.rows ?? []).map((r) => ({ row: r, state: studentState(r, now) }));
    const rank = (s: StudentState) => SUMMARY_ORDER.indexOf(s);
    list.sort((a, b) =>
      sort === "triage"
        ? rank(a.state) - rank(b.state) || a.row.name.localeCompare(b.row.name)
        : a.row.name.localeCompare(b.row.name),
    );
    return list;
  }, [data, now, sort]);

  const counts = useMemo(() => {
    const c = { ...EMPTY_COUNTS };
    for (const r of rows) c[r.state] += 1;
    return c;
  }, [rows]);

  const visible = filter ? rows.filter((r) => r.state === filter) : rows;

  const scopeLabel = data
    ? data.test_session.student_ps_ids
      ? `${data.test_session.student_ps_ids.length} picked students`
      : data.test_session.section_ps_id
        ? "one section"
        : "all your sections"
    : null;

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <PageHeader
        crumbs={[
          { label: "Assessments", href: "/dashboard" },
          { label: assessmentName, href: `/dashboard/${assessmentId}?tab=sessions` },
        ]}
        title={`Monitor ${code}`}
        status={<SessionStatusBadge state={state} />}
        description={
          open ? `${assessmentName} · ${closesAt(session.expires_at, new Date(now))}` : assessmentName
        }
        actions={
          <>
            {open ? (
              <Button type="button" variant="outline" onClick={() => setShowCode(true)}>
                <Presentation aria-hidden />
                Show code
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => load()}>
              Refresh
            </Button>
            {open ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => setPendingClose(true)}>
                Close session
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <SessionCode code={code} size="header" />
        <div className="space-y-1 text-sm">
          {data ? (
            <div>
              {data.counts.joined} of {data.counts.expected} joined · {data.counts.submitted} handed in
            </div>
          ) : null}
          <LiveIndicator
            intervalMs={LIVE_INTERVAL_MS}
            updatedAgo={fetchedAt ? ago(new Date(fetchedAt).toISOString(), now) : "—"}
            failedAt={pollFailedAt}
            onRetry={() => load()}
            live={polling}
          />
        </div>
      </div>

      {actionError ? (
        <Alert variant="destructive">
          <AlertTitle>{actionError}</AlertTitle>
        </Alert>
      ) : null}

      {/* WCAG 4.1.3: the count a teacher would otherwise have to re-scan for. */}
      <p className="sr-only" role="status" aria-live="polite">
        {counts.needs_attention === 0
          ? "Nobody needs attention."
          : `${counts.needs_attention} need${counts.needs_attention === 1 ? "s" : ""} attention.`}
      </p>

      {data === null ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading attendance">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <EmptyState
          icon={<Monitor />}
          title="No one has joined yet"
          description={
            <>
              Open to {scopeLabel}. Students open Secure Test, sign in, and enter code{" "}
              <span className="font-mono font-semibold tracking-widest">{code}</span>.
            </>
          }
          action={
            open ? (
              <Button type="button" variant="outline" onClick={() => setShowCode(true)}>
                <Presentation aria-hidden />
                Show code
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <MonitorSummary counts={counts} active={filter} onSelect={setFilter} />

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {filter ? `Showing ${visible.length} of ${rows.length}. ` : null}
              <ScanEye className="mr-1 inline size-4 align-text-bottom" aria-hidden />
              View screen takes one still of a student&apos;s screen; the student sees a notice.
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSort((s) => (s === "triage" ? "name" : "triage"))}
              aria-pressed={sort === "name"}
            >
              {sort === "triage" ? <ArrowDownAZ aria-hidden /> : <ListOrdered aria-hidden />}
              {sort === "triage" ? "Sort A–Z" : "Sort by status"}
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(({ row: r, state: st }) => (
                  <StudentRow
                    key={r.ps_id}
                    row={r}
                    state={st}
                    now={now}
                    sessionClosed={session.status === "closed"}
                    onDeleted={() => void load()}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <p className="text-sm text-muted-foreground">
        <Link href={`/dashboard/${assessmentId}?tab=sessions`} className="hover:underline">
          Back to test sessions
        </Link>
      </p>

      <ShowCodeDialog open={showCode} onOpenChange={setShowCode} code={code} assessmentName={assessmentName} />

      <AlertDialog
        open={pendingClose}
        onOpenChange={(o) => {
          if (!o && !busy) setPendingClose(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close session {code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Nobody new can join. Students already in can finish and hand in. It
              can&apos;t be reopened — start a new session instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmClose();
              }}
            >
              {busy ? "Closing…" : "Close session"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function StudentRow({
  row: r,
  state: st,
  now,
  sessionClosed,
  onDeleted,
}: {
  row: AttendanceRow;
  state: StudentState;
  now: number;
  sessionClosed: boolean;
  onDeleted: () => void;
}) {
  const idle = idleFor(r, now);
  const current = st === "needs_attention";
  return (
    <TableRow className={cn(current && "shadow-[inset_4px_0_0_var(--danger-foreground)]")}>
      <TableCell>
        <div className="font-medium">
          {r.name}
          {r.in_scope ? null : <span className="ml-2 text-xs text-muted-foreground">(not in scope)</span>}
        </div>
        <div className="text-xs text-muted-foreground">{r.section_label ?? "—"}</div>
      </TableCell>
      <TableCell>
        {r.status === "not_joined" ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <ProgressBar value={r.answered} max={r.total_items} done={r.status === "submitted"} />
        )}
      </TableCell>
      <TableCell>
        {/* Wrapping flex: a long chip drops to the next line rather than
            widening the column (hand-run finding 2026-08-27). */}
        <div className="flex flex-wrap items-center gap-1.5">
          <StudentStatusBadge
            state={st}
            detail={st === "idle" && idle !== null ? `${Math.round(idle / 60_000)} min` : undefined}
          />
          {r.alert && current ? (
            <span className="text-xs text-danger-foreground">
              {eventLabel(r.alert.kind)} · {ago(r.alert.at, now)}
            </span>
          ) : r.alert && !alertIsCurrent(r) ? (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              Earlier: {eventLabel(r.alert.kind)} · {ago(r.alert.at, now)}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {r.status === "not_joined" ? "—" : ago(r.last_activity_at, now)}
      </TableCell>
      <TableCell className="text-right">
        {r.attempt_id && r.status !== "not_joined" ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ViewScreenControl attemptId={r.attempt_id} studentName={r.name} enabled={r.status === "in_progress"} />
            {/* Time limit / unfinished attempts (D-1/A): a student who ran
                out of time or otherwise never handed in. Same enable rule as
                Delete beside it. */}
            {r.status === "in_progress" ? (
              <HandInAttemptControl
                attemptId={r.attempt_id}
                studentName={r.name}
                answeredCount={r.answered}
                onHandedIn={onDeleted}
                disabledReason={sessionClosed ? undefined : "End the test session first, then hand in."}
              />
            ) : null}
            {/* Roadmap 2026-09: a wrong-student join or a retake. Disabled
                while the student may still be locked in — the route 409s
                for the same case (`session_open`). */}
            <DeleteAttemptControl
              attemptId={r.attempt_id}
              studentName={r.name}
              onDeleted={onDeleted}
              disabledReason={
                r.status === "submitted" || sessionClosed
                  ? undefined
                  : "End the test session first, then delete."
              }
            />
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/** How often the row asks "is the frame in yet?" after requesting a peek —
 * its own short poll rather than the 5 s attendance poll, because the GET
 * consumes the image (delete-on-read) and must therefore be the ONE reader,
 * fired only while this row is actually waiting. */
const PEEK_WAIT_INTERVAL_MS = 2_500;
/** Give up after the server's 30 s pending window plus one upload's grace —
 * by then the request has expired server-side and nothing can arrive. */
const PEEK_WAIT_TIMEOUT_MS = 40_000;

type PeekPhase = "idle" | "waiting" | "ready" | "failed";

/**
 * Peek P3 (docs/on-demand-peek-design.md): the teacher's end of the cycle.
 * Click → POST the request → poll the collect endpoint until the student's
 * client answers → show the frame in a dialog. The image lives in component
 * state only, exactly as long as the dialog is open — the server deleted its
 * copy the moment the GET returned it. `capturedAt` is taken when the frame
 * arrives, not at render (SM-20).
 */
function ViewScreenControl({
  attemptId,
  studentName,
  enabled,
}: {
  attemptId: string;
  studentName: string;
  enabled: boolean;
}) {
  const [phase, setPhase] = useState<PeekPhase>("idle");
  const [image, setImage] = useState<string | null>(null);
  const [capturedAt, setCapturedAt] = useState<Date | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  async function requestPeek() {
    setNote(null);
    try {
      const res = await fetch(`/api/attempts/${attemptId}/peek`, { method: "POST" });
      if (res.status === 429) {
        setNote("Just asked — give it a few seconds.");
        return;
      }
      if (res.status === 409) {
        setNote("The student is no longer in the test.");
        return;
      }
      if (!res.ok) throw await readError(res);
    } catch {
      setPhase("failed");
      setNote("Couldn't ask for the screen. Try again.");
      return;
    }
    setPhase("waiting");
    const startedAt = Date.now();
    stopPolling();
    timer.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/attempts/${attemptId}/peek/image`);
        if (!res.ok) throw await readError(res);
        const body = (await res.json()) as { status: string; image_base64?: string };
        if (body.status === "ready" && body.image_base64) {
          stopPolling();
          setImage(body.image_base64);
          setCapturedAt(new Date());
          setPhase("ready");
          return;
        }
        // "pending" keeps waiting; "none" can mean the upload is a beat away
        // (delivered after our GET, swept, raced) — the timeout below is the
        // arbiter, not one "none".
        if (Date.now() - startedAt > PEEK_WAIT_TIMEOUT_MS) {
          stopPolling();
          setPhase("failed");
          setNote("No answer — the student's app may be offline.");
        }
      } catch {
        stopPolling();
        setPhase("failed");
        setNote("Couldn't collect the screen. Try again.");
      }
    }, PEEK_WAIT_INTERVAL_MS);
  }

  function dismiss() {
    // Drop the frame from memory with the dialog; the server's copy is
    // already gone (delete-on-read).
    setImage(null);
    setCapturedAt(null);
    setPhase("idle");
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!enabled || phase === "waiting"}
        title={enabled ? "Takes one still. The student sees a notice." : "Only while the student is in the test."}
        onClick={() => void requestPeek()}
      >
        <ScanEye aria-hidden />
        {phase === "failed" ? "Try again" : "View screen"}
      </Button>
      {phase === "waiting" ? (
        <Badge variant="info" role="status">
          Requested…
        </Badge>
      ) : phase === "failed" ? (
        <Badge variant="neutral" role="status">
          No answer
        </Badge>
      ) : null}
      {note ? (
        <p className="max-w-48 text-right text-xs text-muted-foreground" role="status">
          {note}
        </p>
      ) : null}
      <ViewScreenDialog
        open={phase === "ready" && image !== null}
        onOpenChange={(o) => {
          if (!o) dismiss();
        }}
        studentName={studentName}
        imageBase64={image}
        capturedAt={capturedAt}
      />
    </div>
  );
}
