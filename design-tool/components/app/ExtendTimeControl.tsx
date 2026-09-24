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
  | { kind: "attempt"; attemptId: string }
  /** Remove time limit + Monitor checkboxes (2026-09-24): some of a sitting's
   * students, posted to the sitting route with `attempt_ids`. Unlike the
   * whole-sitting target it never changes the sitting's own flag, so later
   * joiners are unaffected. */
  | { kind: "selected"; sessionId: string; attemptIds: string[] };

/** The dialog's two choices (2026-09-24): an absolute deadline, or none. */
export type ExtendChoice = "deadline" | "no_limit";

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
 *
 * The "No time limit" choice (2026-09-24) has its own line, and only the
 * WHOLE-sitting target mentions later joiners: that is the one adjustment that
 * sets the sitting's flag. Selected students are just those attempts.
 */
export function extendHint(
  target: ExtendTarget["kind"],
  choice: ExtendChoice = "deadline",
): string {
  if (choice === "no_limit") {
    if (target === "sitting") {
      return (
        "Every student still in progress, and anyone who joins this session " +
        "later, has no time limit."
      );
    }
    if (target === "selected") return "The selected students have no time limit.";
    return "This student has no time limit.";
  }
  if (target === "sitting") {
    return "Every student still in progress on this session gets until this time.";
  }
  if (target === "selected") return "The selected students get until this time.";
  return "This student gets until this time.";
}

/**
 * "Adjusted 3 students." / "Adjusted 1 student." / "Adjusted." — and for "No
 * time limit", "Time limit removed for 3 students." / "Time limit removed.".
 */
export function extendStatusText(
  target: ExtendTarget["kind"],
  extended: number,
  choice: ExtendChoice = "deadline",
): string {
  const students = `${extended} student${extended === 1 ? "" : "s"}`;
  if (choice === "no_limit") {
    return target === "attempt"
      ? "Time limit removed."
      : `Time limit removed for ${students}.`;
  }
  if (target === "attempt") return "Adjusted.";
  return `Adjusted ${students}.`;
}

/**
 * What the dialog posts, or null when the deadline choice has no usable time
 * (the caller says "Pick a time in the future."). Pure so the XOR the routes
 * enforce — `ends_at` or `no_limit`, never both — is tested here too, and the
 * selected-students target carries its `attempt_ids`.
 */
export function extendRequest(
  target: ExtendTarget,
  choice: ExtendChoice,
  localValue: string,
): { url: string; body: Record<string, unknown> } | null {
  const url =
    target.kind === "attempt"
      ? `/api/attempts/${target.attemptId}/extend`
      : `/api/test-sessions/${target.sessionId}/extend`;
  let body: Record<string, unknown>;
  if (choice === "no_limit") {
    body = { no_limit: true };
  } else {
    const endsAt = toIsoInstant(localValue);
    if (!endsAt) return null;
    body = { ends_at: endsAt };
  }
  if (target.kind === "selected") body.attempt_ids = target.attemptIds;
  return { url, body };
}

/**
 * Today at 23:59, local time, in the `datetime-local` input's own string
 * shape ("YYYY-MM-DDTHH:mm") — pure and injectable with `now` so the default
 * is testable without depending on the clock. Pilot teachers asked for today
 * (2026-09-24; it was tomorrow). In the last minute of the day today's 23:59
 * is no longer in the future and the server would refuse it, so the default
 * falls to tomorrow.
 */
export function defaultExtendValue(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setHours(23, 59, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * EX-1 (2026-09-23): the hint under the picker when the chosen time is
 * EARLIER than a current deadline — for a sitting, earlier than the latest
 * deadline among the students it applies to. Allowed on purpose (the teacher
 * may mean it); the hint only says so. Null when nothing would be shortened,
 * the value is empty or unparseable, or no current deadline is known.
 */
export function shortensHint(
  localValue: string,
  currentDeadlines: ReadonlyArray<string | Date | null | undefined> | undefined,
): string | null {
  const chosen = toIsoInstant(localValue);
  if (!chosen || !currentDeadlines) return null;
  const latest = currentDeadlines.reduce<number>((max, d) => {
    if (!d) return max;
    const ms = new Date(d).getTime();
    return Number.isNaN(ms) ? max : Math.max(max, ms);
  }, Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(latest)) return null;
  return new Date(chosen).getTime() < latest
    ? "This is earlier than the current deadline — it shortens their time."
    : null;
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
 * "Adjust time" — "Extend time" until 2026-09-24, renamed because the same
 * dialog also shortens a deadline (docs/time-limit-and-unfinished-attempts-design.md follow-up,
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
 *
 * Remove time limit (2026-09-24): the dialog offers "New deadline" (the
 * picker) or "No time limit", and a third target — the Monitor's checked
 * students — posts to the sitting route with `attempt_ids`. `label` lets that
 * caller name the button "Adjust time for selected (N)".
 */
export function ExtendTimeControl({
  target,
  onExtended,
  disabledReason,
  size = "sm",
  variant = "outline",
  currentDeadlines,
  label = "Adjust time",
}: {
  target: ExtendTarget;
  /** The button's text; the dialog's title stays "Adjust time". */
  label?: string;
  onExtended: () => void;
  disabledReason?: string;
  /** The in-scope students' current deadlines, for the "shortens" hint. */
  currentDeadlines?: ReadonlyArray<string | Date | null | undefined>;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState<ExtendChoice>("deadline");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setValue(defaultExtendValue());
    setChoice("deadline");
    setOpen(true);
  }

  async function confirmExtend() {
    const request = extendRequest(target, choice, value);
    if (!request) {
      setError("Pick a time in the future.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { extended?: number };
      setStatus(extendStatusText(target.kind, body.extended ?? 0, choice));
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
          {label}
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
            <DialogTitle>Adjust time</DialogTitle>
            <DialogDescription>{extendHint(target.kind, choice)}</DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-2 text-sm" disabled={busy}>
            <legend className="sr-only">Time limit</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="extend-choice"
                value="deadline"
                checked={choice === "deadline"}
                onChange={() => setChoice("deadline")}
              />
              New deadline
            </label>
            <input
              type="datetime-local"
              value={value}
              disabled={busy || choice !== "deadline"}
              onChange={(e) => setValue(e.target.value)}
              aria-label="New deadline"
              className="ml-6 w-[calc(100%-1.5rem)] rounded-md border border-border bg-transparent px-2 py-1 text-sm disabled:opacity-50"
            />
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="extend-choice"
                value="no_limit"
                checked={choice === "no_limit"}
                onChange={() => setChoice("no_limit")}
              />
              No time limit
            </label>
          </fieldset>
          {choice === "deadline" && shortensHint(value, currentDeadlines) ? (
            <p className="text-xs text-muted-foreground">
              {shortensHint(value, currentDeadlines)}
            </p>
          ) : null}
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
              {busy ? "Adjusting…" : "Adjust"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
