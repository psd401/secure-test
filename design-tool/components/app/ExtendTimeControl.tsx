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
import { ApiError, extendErrorCopy } from "@/lib/ui/errorCopy";

export type ExtendTarget =
  | { kind: "sitting"; sessionId: string }
  | { kind: "attempt"; attemptId: string };

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
  return extendErrorCopy(code).message;
}

/**
 * "Every student still in progress on this session gets until this time" /
 * "This student gets until this time" — the dialog's one-line hint, pure so
 * it is testable without a DOM (the repo has no testing-library harness).
 */
export function extendHint(target: ExtendTarget["kind"]): string {
  return target === "sitting"
    ? "Every student still in progress on this session gets until this time."
    : "This student gets until this time.";
}

/** "Extended 3 students." / "Extended 1 student." / "Extended." */
export function extendStatusText(target: ExtendTarget["kind"], extended: number): string {
  if (target === "attempt") return "Extended.";
  return `Extended ${extended} student${extended === 1 ? "" : "s"}.`;
}

/**
 * Tomorrow at 23:59, local time, in the `datetime-local` input's own string
 * shape ("YYYY-MM-DDTHH:mm") — pure and injectable with `now` so the default
 * is testable without depending on the clock.
 */
export function defaultExtendValue(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(23, 59, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A `datetime-local` value ("YYYY-MM-DDTHH:mm", read as local time by the
 * browser) turned into an ISO instant. `null` when the value is empty or
 * unparseable, which the caller treats as "nothing to submit" rather than
 * guessing a time.
 */
export function toIsoInstant(localValue: string): string | null {
  if (!localValue) return null;
  const ms = new Date(localValue).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * "Extend time" (docs/time-limit-and-unfinished-attempts-design.md follow-up,
 * built 2026-09-17 server-side in 889cf38): a teacher-chosen absolute instant,
 * posted to whichever route the caller's `target` names —
 * POST /api/attempts/[attemptId]/extend for one student, or
 * POST /api/test-sessions/[sessionId]/extend for every in-progress attempt on
 * a sitting.
 *
 * Same shape as `HandInAllControl` / `HandInAttemptControl`: the caller
 * decides where it sits, whether it is enabled (`disabledReason`, rendered as
 * the button's title while disabled), and what happens afterwards
 * (`onExtended`). Unlike those controls there is no "are you sure" — the
 * action is additive, not destructive — so the click opens straight into a
 * small inline dialog asking for the new deadline instead of a confirm.
 */
export function ExtendTimeControl({
  target,
  onExtended,
  disabledReason,
  size = "sm",
  variant = "outline",
}: {
  target: ExtendTarget;
  onExtended: () => void;
  disabledReason?: string;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setValue(defaultExtendValue());
    setOpen(true);
  }

  async function confirmExtend() {
    const endsAt = toIsoInstant(value);
    if (!endsAt) {
      setError("Pick a time in the future.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url =
        target.kind === "sitting"
          ? `/api/test-sessions/${target.sessionId}/extend`
          : `/api/attempts/${target.attemptId}/extend`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ends_at: endsAt }),
      });
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { extended?: number };
      setStatus(extendStatusText(target.kind, body.extended ?? 0));
      setOpen(false);
      onExtended();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="inline-flex flex-col items-end gap-1">
        <Button
          type="button"
          variant={variant}
          size={size}
          disabled={disabledReason !== undefined}
          title={disabledReason}
          onClick={openDialog}
        >
          Extend time
        </Button>
        {status ? (
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        ) : null}
      </span>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Extend time</DialogTitle>
            <DialogDescription>{extendHint(target.kind)}</DialogDescription>
          </DialogHeader>
          <label className="text-sm">
            <span className="block text-xs text-muted-foreground">New deadline</span>
            <input
              type="datetime-local"
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
              aria-label="New deadline"
              className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void confirmExtend()} disabled={busy}>
              {busy ? "Extending…" : "Extend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
