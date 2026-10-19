"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ApiError, sessionErrorCopy } from "@/lib/ui/errorCopy";
import {
  continueSessionBody,
  restOfDayMinutes,
} from "@/app/dashboard/[id]/attendanceView";

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

/** Row ES: the new sitting's Monitor, opening on the code (`?code=1`). */
export function continuedMonitorHref(assessmentId: string, sittingId: string): string {
  return `/dashboard/${assessmentId}/monitor/${sittingId}?code=1`;
}

/**
 * Row ES (docs/ended-session-rejoin-design.md, D-1 (a) / D-5): "Continue in a
 * new session" on an ended or closed class sitting. Starts a new sitting with
 * the ended one's scope (`continueSessionBody`) and the length the teacher
 * picks, then opens its Monitor with the code showing. Students who were mid-
 * test resume there (finding 8.2 rebinds their attempt), absent students start,
 * handed-in students are told they already handed in.
 *
 * A 409 `sitting_already_open` (U-13: the same scope is already open — a
 * second press, or a session started by hand) goes to that sitting instead.
 * Navigation is a full page load, like the other list-row leaves, so the
 * headless dashboard render tests need no router.
 */
export function ContinueInNewSessionControl({
  assessmentId,
  sitting,
  size = "sm",
  variant = "outline",
}: {
  assessmentId: string;
  sitting: { section_ps_id: string | null; student_ps_ids: string[] | null };
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "ghost" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(55);
  const presets = [
    { label: "This period · 55 min", value: 55 },
    { label: "90 min", value: 90 },
    { label: "Rest of day", value: restOfDayMinutes(new Date()) },
  ];

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/test-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(continueSessionBody(assessmentId, sitting, minutes)),
      });
      if (res.status === 409) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          test_session_id?: unknown;
        };
        if (payload.error === "sitting_already_open" && typeof payload.test_session_id === "string") {
          window.location.assign(continuedMonitorHref(assessmentId, payload.test_session_id));
          return;
        }
        throw new ApiError(typeof payload.error === "string" ? payload.error : "http_409", 409);
      }
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { test_session?: { id?: unknown } };
      const id = body.test_session?.id;
      if (typeof id !== "string") throw new ApiError("http_201", 201);
      window.location.assign(continuedMonitorHref(assessmentId, id));
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Continue in a new session
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Continue in a new session</DialogTitle>
            <DialogDescription>
              Starts a new session for the same students, with a new code.
              Students who didn&apos;t finish pick up where they left off;
              students who were absent start the test.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Session length">
            {presets.map((p) => (
              <Button
                key={p.label}
                type="button"
                size="sm"
                variant={minutes === p.value ? "secondary" : "outline"}
                aria-pressed={minutes === p.value}
                disabled={busy}
                onClick={() => setMinutes(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={() => void start()}>
              {busy ? "Starting…" : "Start session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
