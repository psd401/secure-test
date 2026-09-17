"use client";

import { useState } from "react";
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
import { ApiError, attemptHandInErrorCopy } from "@/lib/ui/errorCopy";

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
  const copy = attemptHandInErrorCopy(code);
  return copy.showCode ? `${copy.message} ${code}` : copy.message;
}

/**
 * The confirm dialog's body ("Hand in everyone now", James 2026-09-16).
 *
 * Pure, and exported for the same reason `handInConfirmCopy` is: Radix's
 * AlertDialog content sits behind a Portal that is unmounted while the dialog
 * is closed, so the copy cannot be reached through static markup.
 *
 * Mirrors `closeDialogCopy`'s treatment of an unknown count: the Test sessions
 * tab only holds attendance rows for a sitting whose Attendance is expanded,
 * so 0 doubles as "not known" and gets wording that is true either way.
 */
export function handInAllDialogCopy(inProgress: number): string {
  const who =
    inProgress <= 0
      ? "everyone still working"
      : `${inProgress} student${inProgress === 1 ? "" : "s"} still working`;
  return (
    `Hand in ${who}? Their answers are saved as they are, and they can't ` +
    "continue. This can't be undone."
  );
}

/**
 * "Hand in everyone" — the per-attempt forced hand-in applied to a whole
 * sitting (POST /api/test-sessions/[sessionId]/hand-in-all). Same shape as
 * `HandInAttemptControl`: the caller decides where it sits, what the count is,
 * whether it is enabled, and what happens afterwards (`onHandedIn`, which the
 * monitor and the sittings panel both use to re-fetch attendance).
 *
 * `disabledReason` renders it disabled with that text as its title, the same
 * signal the per-attempt Hand in and Delete controls use.
 */
export function HandInAllControl({
  sessionId,
  inProgress,
  onHandedIn,
  disabledReason,
  size = "sm",
  variant = "outline",
}: {
  sessionId: string;
  /** Students still working, as the caller's rows say; 0 when not known. */
  inProgress: number;
  onHandedIn: () => void;
  disabledReason?: string;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function confirmHandInAll() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/test-sessions/${sessionId}/hand-in-all`, { method: "POST" });
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { handed_in?: number };
      setStatus(`Handed in ${body.handed_in ?? 0}.`);
      setOpen(false);
      onHandedIn();
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
          onClick={() => {
            setError(null);
            setStatus(null);
            setOpen(true);
          }}
        >
          Hand in everyone
        </Button>
        {status ? (
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        ) : null}
      </span>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hand in everyone?</AlertDialogTitle>
            <AlertDialogDescription>{handInAllDialogCopy(inProgress)}</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmHandInAll();
              }}
            >
              {busy ? "Handing in…" : "Hand in everyone"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
