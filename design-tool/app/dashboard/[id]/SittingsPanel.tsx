"use client";

// Slice 82: sittings for one assessment — create (scope + duration), read the
// code off the screen, close early, and see who has joined or submitted.
// Every action is an existing or slice-82 endpoint; this panel holds no rules
// of its own.
//
// UX pass 1, slice 6 (SM-03/04/06..09/16..19): the teacher-facing words are
// "test session" / "session code" (identifiers unchanged); the load state is
// explicit so a failed fetch never renders as "no sections"; action failures
// and live-poll failures have separate channels; Close asks first; the code is
// the hero of each row with Copy and a projector view.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Monitor, PlayCircle, Presentation } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
import { ProgressBar } from "@/components/app/ProgressBar";
import { SessionCode } from "@/components/app/SessionCode";
import { ShowCodeDialog } from "@/components/app/ShowCodeDialog";
import {
  SessionStatusBadge,
  StudentStatusBadge,
  sessionState,
} from "@/components/app/StatusBadge";
import { ApiError, sessionErrorCopy } from "@/lib/ui/errorCopy";
import { closesAt, formatWhen } from "@/lib/ui/format";
import {
  LIVE_INTERVAL_MS,
  ago,
  alertIsCurrent,
  eventLabel,
  idleFor,
  studentState,
  type AttendancePayload,
  type AttendanceRow,
} from "./attendanceView";

// A first-load fetch that never settles (an extension-intercepted request
// hangs forever — the SittingsPanel stall, ux-pass-2-proposal.md follow-up)
// must become the SM-04 error+retry state, not a permanent "Loading".
const FIRST_LOAD_TIMEOUT_MS = 15_000;

interface Section {
  ps_id: string;
  course_code: string | null;
  course_name: string | null;
  period_expression: string | null;
  student_count: number;
}

interface RosterStudent {
  ps_id: string;
  name: string;
  grade: string | null;
  sections: { ps_id: string; label: string }[];
}

interface Sitting {
  id: string;
  code: string;
  status: string;
  expires_at: string;
  created_at: string;
  section_ps_id: string | null;
  student_ps_ids: string[] | null;
}

interface Attendance {
  rows: AttendanceRow[];
  counts: { expected: number; joined: number; submitted: number };
  updated_at: string | null;
  total_items: number;
  /** Client-side: when this snapshot was fetched. */
  fetched_at: number;
}

type Scope = "all" | "section" | "students";

interface Props {
  assessmentId: string;
  /** Shown on the projector view (Show code). */
  assessmentName: string;
  /** Sittings can only be created on a published assessment (server-enforced). */
  isPublished: boolean;
  /** UX pass 1, slice 4 (A-10): opens the editor's Publish dialog from the draft notice. */
  onPublish?: () => void;
}

function sectionLabel(s: Section): string {
  const name = s.course_name || s.course_code || `Section ${s.ps_id}`;
  return s.period_expression ? `${name} · ${s.period_expression}` : name;
}

function isOpen(s: Sitting): boolean {
  return s.status === "open" && new Date(s.expires_at).getTime() > Date.now();
}

const MIN_MINUTES = 1;
const MAX_MINUTES = 720;

/** Minutes from `now` until 4:00 PM Pacific today, clamped to the API's range. */
function restOfDayMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const left = 16 * 60 - (h * 60 + m);
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, left > 0 ? left : 60));
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

export function SittingsPanel({ assessmentId, assessmentName, isPublished, onPublish }: Props) {
  const [sections, setSections] = useState<Section[]>([]);
  const [roster, setRoster] = useState<RosterStudent[] | null>(null);
  const [sittings, setSittings] = useState<Sitting[]>([]);
  const [attendance, setAttendance] = useState<Record<string, Attendance>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  // Explicit load state (SM-04): a failed first fetch shows an error with
  // Retry — never the empty "no sections" copy.
  const [loadState, setLoadState] = useState<"loading" | "error" | "ready">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Form/action failures (SM-06): cleared only by the next action.
  const [actionError, setActionError] = useState<string | null>(null);
  // Live-poll failures: reported beside the stale table, not in the form.
  const [pollFailedAt, setPollFailedAt] = useState<Date | null>(null);
  const [showCode, setShowCode] = useState<Sitting | null>(null);
  const [pendingClose, setPendingClose] = useState<Sitting | null>(null);

  const [now, setNow] = useState(() => Date.now());
  const [scope, setScope] = useState<Scope>("all");
  const [sectionPsId, setSectionPsId] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [minutes, setMinutes] = useState("55");

  const loadSittings = useCallback(async () => {
    const res = await fetch(`/api/test-sessions?assessment_id=${assessmentId}`, {
      signal: AbortSignal.timeout(FIRST_LOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw await readError(res);
    const body = (await res.json()) as { test_sessions: Sitting[] };
    setSittings(body.test_sessions);
  }, [assessmentId]);

  const loadAll = useCallback(async () => {
    // Breadcrumb for the stall investigation: a stuck "Loading" with this
    // line present in the console means the fetch hung; absent means the
    // effect never ran (hydration casualty).
    console.info("sittings: loadAll start");
    setLoadState("loading");
    setLoadError(null);
    try {
      const secRes = await fetch(`/api/roster/sections`, {
        signal: AbortSignal.timeout(FIRST_LOAD_TIMEOUT_MS),
      });
      if (!secRes.ok) throw await readError(secRes);
      const secBody = (await secRes.json()) as { sections: Section[] };
      setSections(secBody.sections);
      setSectionPsId((prev) => prev || (secBody.sections[0]?.ps_id ?? ""));
      await loadSittings();
      setLoadState("ready");
    } catch (err) {
      setLoadError(describe(err));
      setLoadState("error");
    }
  }, [loadSittings]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // The roster is only fetched when the teacher asks to pick students.
  useEffect(() => {
    if (scope !== "students" || roster !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/roster/students`, {
          signal: AbortSignal.timeout(FIRST_LOAD_TIMEOUT_MS),
        });
        if (!res.ok) throw await readError(res);
        const body = (await res.json()) as { students: RosterStudent[] };
        if (!cancelled) setRoster(body.students);
      } catch (err) {
        if (!cancelled) setActionError(describe(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, roster]);

  // Slice 86: while an open sitting's attendance is on screen, re-fetch every
  // LIVE_INTERVAL_MS — paused while the tab is hidden, stopped once the
  // sitting is closed or expired. Same endpoint as the Refresh button; this
  // is polling by design (docs/phase-7-slices.md, monitor v2 transport).
  const liveId = useMemo(() => {
    if (!expanded) return null;
    const s = sittings.find((x) => x.id === expanded);
    return s && isOpen(s) ? s.id : null;
  }, [expanded, sittings]);

  useEffect(() => {
    if (!liveId) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      void loadAttendance(liveId);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveId]);

  const sectionById = useMemo(() => {
    const m = new Map<string, Section>();
    for (const s of sections) m.set(s.ps_id, s);
    return m;
  }, [sections]);

  function scopeLabel(s: Sitting): string {
    if (s.student_ps_ids) return `${s.student_ps_ids.length} picked student${s.student_ps_ids.length === 1 ? "" : "s"}`;
    if (s.section_ps_id) {
      const sec = sectionById.get(s.section_ps_id);
      return sec ? sectionLabel(sec) : `Section ${s.section_ps_id}`;
    }
    return "All my sections";
  }

  const minutesNumber = Number(minutes);
  const minutesValid =
    Number.isInteger(minutesNumber) && minutesNumber >= MIN_MINUTES && minutesNumber <= MAX_MINUTES;
  const canStart = isPublished && sections.length > 0 && minutesValid && !busy;
  const closesPreview = minutesValid ? closesAt(new Date(now + minutesNumber * 60_000), new Date(now)) : null;

  async function createSitting() {
    setBusy(true);
    setActionError(null);
    try {
      if (!minutesValid) throw new ApiError("invalid_body", 400);
      const body: Record<string, unknown> = { assessment_id: assessmentId, duration_minutes: minutesNumber };
      if (scope === "section") {
        if (!sectionPsId) throw new ApiError("section_not_taught", 400);
        body.section_ps_id = sectionPsId;
      } else if (scope === "students") {
        if (picked.size === 0) throw new ApiError("students_not_taught", 400);
        body.student_ps_ids = [...picked];
      }
      const res = await fetch(`/api/test-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await readError(res);
      setNow(Date.now());
      await loadSittings();
    } catch (err) {
      setActionError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmClose() {
    const target = pendingClose;
    if (!target) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/test-sessions/${target.id}/close`, { method: "POST" });
      if (!res.ok) throw await readError(res);
      setNow(Date.now());
      await loadSittings();
    } catch (err) {
      setActionError(describe(err));
    } finally {
      setBusy(false);
      setPendingClose(null);
    }
  }

  async function loadAttendance(id: string) {
    try {
      const res = await fetch(`/api/test-sessions/${id}/attendance`);
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as AttendancePayload;
      setAttendance((prev) => ({ ...prev, [id]: { ...body, fetched_at: Date.now() } }));
      setNow(Date.now());
      setPollFailedAt(null);
    } catch {
      // Keep the last snapshot on screen; LiveIndicator says it is stale.
      setPollFailedAt(new Date());
    }
  }

  async function toggleAttendance(id: string) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    await loadAttendance(id);
  }

  function togglePicked(psId: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(psId)) next.delete(psId);
      else next.add(psId);
      return next;
    });
  }

  if (loadState === "loading") {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading test sessions">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load your test sessions.</AlertTitle>
        <AlertDescription>
          <p>{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => loadAll()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4">
          <h3 className="text-lg font-semibold">Start a test session</h3>

          {!isPublished ? (
            <Alert variant="warning">
              <AlertTitle>Publish the assessment to start a test session.</AlertTitle>
              <AlertDescription>
                <p>
                  A draft can still change while a student is in it, so sessions
                  are only offered once it is locked.
                </p>
                {onPublish ? (
                  <Button type="button" size="sm" className="mt-2" onClick={onPublish}>
                    Publish
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {sections.length === 0 ? (
            <Alert variant="warning">
              <AlertTitle>Your class list hasn&apos;t arrived from PowerSchool yet.</AlertTitle>
              <AlertDescription>
                It updates each morning around 6 AM. A session needs at least one
                section so students can be admitted. If it is still empty
                tomorrow, let Research &amp; Assessment know.
              </AlertDescription>
            </Alert>
          ) : null}

          <fieldset className="space-y-2" disabled={!isPublished || sections.length === 0}>
            <legend className="text-sm font-medium">Who is it for?</legend>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} />
                All my sections
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" checked={scope === "section"} onChange={() => setScope("section")} />
                One section
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" checked={scope === "students"} onChange={() => setScope("students")} />
                Picked students
              </label>
            </div>
            {scope === "section" ? (
              <NativeSelect
                value={sectionPsId}
                onChange={(e) => setSectionPsId(e.target.value)}
                aria-label="Section"
              >
                {sections.map((s) => (
                  <NativeSelectOption key={s.ps_id} value={s.ps_id}>
                    {sectionLabel(s)} ({s.student_count})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : null}
            {scope === "students" ? (
              roster === null ? (
                <Skeleton className="h-24 w-full" />
              ) : roster.length === 0 ? (
                <p className="text-sm text-muted-foreground">No students in your sections.</p>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded-md border bg-background p-2 text-sm">
                  {roster.map((st) => (
                    <label key={st.ps_id} className="flex items-center gap-2 py-0.5">
                      <input
                        type="checkbox"
                        checked={picked.has(st.ps_id)}
                        onChange={() => togglePicked(st.ps_id)}
                      />
                      <span>{st.name}</span>
                      <span className="text-muted-foreground">
                        {st.sections.map((s) => s.label).join(", ")}
                      </span>
                    </label>
                  ))}
                  <p className="pt-1 text-muted-foreground">{picked.size} picked</p>
                </div>
              )
            ) : null}
          </fieldset>

          <fieldset className="space-y-2" disabled={!isPublished || sections.length === 0}>
            <legend className="text-sm font-medium">How long?</legend>
            <div className="flex flex-wrap items-center gap-2">
              {[
                { label: "This period · 55 min", value: 55 },
                { label: "90 min", value: 90 },
                { label: "Rest of day", value: restOfDayMinutes(new Date(now)) },
              ].map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  size="sm"
                  variant={minutesNumber === preset.value ? "secondary" : "outline"}
                  aria-pressed={minutesNumber === preset.value}
                  onClick={() => {
                    setNow(Date.now());
                    setMinutes(String(preset.value));
                  }}
                >
                  {preset.label}
                </Button>
              ))}
              <span className="flex items-center gap-2 text-sm">
                <Label htmlFor="session-minutes" className="sr-only">
                  Minutes
                </Label>
                <Input
                  id="session-minutes"
                  type="number"
                  inputMode="numeric"
                  min={MIN_MINUTES}
                  max={MAX_MINUTES}
                  step={1}
                  className="w-24"
                  value={minutes}
                  aria-invalid={minutesValid ? undefined : true}
                  onChange={(e) => {
                    setNow(Date.now());
                    setMinutes(e.target.value);
                  }}
                />
                minutes
              </span>
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {minutesValid
                ? `Opens now · ${closesPreview}`
                : `Enter a whole number of minutes from ${MIN_MINUTES} to ${MAX_MINUTES}.`}
            </p>
          </fieldset>

          {actionError ? (
            <Alert variant="destructive">
              <AlertTitle>{actionError}</AlertTitle>
            </Alert>
          ) : null}

          <Button type="button" disabled={!canStart} onClick={createSitting}>
            <PlayCircle aria-hidden />
            {busy ? "Starting…" : "Start session"}
          </Button>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Test sessions ({sittings.length})</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => loadSittings().catch((e) => setActionError(describe(e)))}
          >
            Refresh
          </Button>
        </div>

        {sittings.length === 0 ? (
          <EmptyState
            icon={<PlayCircle />}
            title="No test sessions yet"
            description={
              isPublished
                ? "Start one above. Students open Secure Test and enter the code you read out."
                : "Publish the assessment, then start a session — students join with a code you read out."
            }
          />
        ) : (
          <ul className="space-y-3">
            {sittings.map((s) => {
              const state = sessionState(s, now);
              const open = state === "open";
              const att = attendance[s.id];
              return (
                <li key={s.id}>
                  <Card>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                          <SessionCode code={s.code} size="row" />
                          <SessionStatusBadge state={state} />
                          <span className="text-sm">{scopeLabel(s)}</span>
                          <span className="text-sm text-muted-foreground">
                            {open
                              ? closesAt(s.expires_at, new Date(now))
                              : `Started ${formatWhen(s.created_at, new Date(now))}`}
                          </span>
                        </div>
                        <span className="flex shrink-0 flex-wrap gap-2">
                          {open ? (
                            <Button type="button" variant="outline" size="sm" onClick={() => setShowCode(s)}>
                              <Presentation aria-hidden />
                              Show code
                            </Button>
                          ) : null}
                          {open ? (
                            <Button asChild size="sm">
                              <Link href={`/dashboard/${assessmentId}/monitor/${s.id}`}>
                                <Monitor aria-hidden />
                                Monitor
                              </Link>
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-expanded={expanded === s.id}
                            onClick={() => toggleAttendance(s.id)}
                          >
                            {expanded === s.id ? "Hide attendance" : "Attendance"}
                          </Button>
                          {open ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => setPendingClose(s)}
                            >
                              Close session
                            </Button>
                          ) : null}
                        </span>
                      </div>

                      {expanded === s.id ? (
                        att ? (
                          <div className="space-y-2 text-sm">
                            <div className="flex flex-wrap items-center gap-4">
                              <span>
                                {att.counts.joined} of {att.counts.expected} joined · {att.counts.submitted} handed in
                              </span>
                              <Button type="button" variant="outline" size="xs" onClick={() => loadAttendance(s.id)}>
                                Refresh
                              </Button>
                              <LiveIndicator
                                intervalMs={LIVE_INTERVAL_MS}
                                updatedAgo={ago(new Date(att.fetched_at).toISOString(), now)}
                                failedAt={liveId === s.id ? pollFailedAt : null}
                                onRetry={() => loadAttendance(s.id)}
                                live={liveId === s.id}
                              />
                            </div>
                            {att.rows.length === 0 ? (
                              <p className="text-muted-foreground">
                                Nobody is in this session&rsquo;s scope right now.
                              </p>
                            ) : (
                              <div className="overflow-x-auto rounded-md border">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Student</TableHead>
                                      <TableHead>Section</TableHead>
                                      <TableHead>Status</TableHead>
                                      <TableHead>Progress</TableHead>
                                      <TableHead>Last activity</TableHead>
                                      <TableHead>Started</TableHead>
                                      <TableHead>Handed in</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {att.rows.map((r) => {
                                      const st = studentState(r, now);
                                      const idle = idleFor(r, now);
                                      return (
                                        <TableRow key={r.ps_id}>
                                          <TableCell>
                                            {r.name}
                                            {r.in_scope ? null : (
                                              <span className="ml-2 text-xs text-muted-foreground">(not in scope)</span>
                                            )}
                                          </TableCell>
                                          <TableCell>{r.section_label ?? "—"}</TableCell>
                                          <TableCell>
                                            {/* Wrapping flex: a long chip drops to the next
                                                line rather than widening the column
                                                (hand-run finding 2026-08-27). */}
                                            <span className="flex flex-wrap items-center gap-1">
                                              <StudentStatusBadge
                                                state={st}
                                                detail={st === "idle" && idle !== null ? `${Math.round(idle / 60_000)} min` : undefined}
                                              />
                                              {r.alert && st === "needs_attention" ? (
                                                <span className="text-xs text-danger-foreground">
                                                  {eventLabel(r.alert.kind)} · {ago(r.alert.at, now)}
                                                </span>
                                              ) : r.alert && !alertIsCurrent(r) ? (
                                                <span className="text-xs text-muted-foreground">
                                                  Earlier: {eventLabel(r.alert.kind)} · {ago(r.alert.at, now)}
                                                </span>
                                              ) : null}
                                            </span>
                                          </TableCell>
                                          <TableCell>
                                            {r.status === "not_joined" ? (
                                              "—"
                                            ) : (
                                              <ProgressBar value={r.answered} max={r.total_items} done={r.status === "submitted"} />
                                            )}
                                          </TableCell>
                                          <TableCell>{r.status === "not_joined" ? "—" : ago(r.last_activity_at, now)}</TableCell>
                                          <TableCell className="whitespace-nowrap">
                                            {r.started_at ? formatWhen(r.started_at, new Date(now)) : "—"}
                                          </TableCell>
                                          <TableCell className="whitespace-nowrap">
                                            {r.submitted_at ? formatWhen(r.submitted_at, new Date(now)) : "—"}
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              </div>
                            )}
                          </div>
                        ) : (
                          <Skeleton className="h-16 w-full" />
                        )
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ShowCodeDialog
        open={showCode !== null}
        onOpenChange={(open) => {
          if (!open) setShowCode(null);
        }}
        code={showCode?.code ?? ""}
        assessmentName={assessmentName}
      />

      <AlertDialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingClose(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close session {pendingClose?.code}?</AlertDialogTitle>
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
    </div>
  );
}
