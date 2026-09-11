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
 * The confirm dialog's body (design note, "Confirm dialog copy"). Exported
 * as a pure function — Radix's AlertDialog content sits behind a Portal that
 * is unmounted while `open` is false, so a static-markup test can't reach it
 * through the component tree the way the disabled-button note can; this is
 * the copy under test instead.
 */
export function handInConfirmCopy(answeredCount: number): string {
  return (
    `Their ${answeredCount} answered question${answeredCount === 1 ? "" : "s"} become ` +
    "their final answers and auto-scoring runs. They will not be able to change them."
  );
}

/**
 * "Hand in" — force a submission on the student's behalf
 * (docs/time-limit-and-unfinished-attempts-design.md, D-1/A): confirm first,
 * then POST /api/attempts/[attemptId]/hand-in. Mirrors
 * `DeleteAttemptControl` exactly: owner-only server-side, the caller decides
 * where it sits (the results matrix, the per-student page, a monitor row)
 * and what happens after (`onHandedIn`), and `disabledReason` renders the
 * button disabled with that text as its title while the sitting is open —
 * the same signal Delete uses.
 */
export function HandInAttemptControl({
  attemptId,
  studentName,
  answeredCount,
  onHandedIn,
  disabledReason,
  size = "sm",
}: {
  attemptId: string;
  studentName: string;
  /** k in "Their k answered questions become their final answers…". */
  answeredCount: number;
  onHandedIn: () => void;
  disabledReason?: string;
  size?: "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmHandIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/attempts/${attemptId}/hand-in`, { method: "POST" });
      if (!res.ok) throw await readError(res);
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
      <Button
        type="button"
        variant="outline"
        size={size}
        disabled={disabledReason !== undefined}
        title={disabledReason}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Hand in
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hand in for {studentName}?</AlertDialogTitle>
            <AlertDialogDescription>{handInConfirmCopy(answeredCount)}</AlertDialogDescription>
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
                void confirmHandIn();
              }}
            >
              {busy ? "Handing in…" : "Hand in"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
