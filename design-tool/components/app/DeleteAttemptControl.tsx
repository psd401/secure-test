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
import { ApiError, attemptDeleteErrorCopy } from "@/lib/ui/errorCopy";

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
  const copy = attemptDeleteErrorCopy(code);
  return copy.showCode ? `${copy.message} ${code}` : copy.message;
}

/**
 * "Delete attempt" — confirm first, then DELETE /api/attempts/[attemptId]
 * (roadmap 2026-09, the 2026-09-07 finding). Owner-only server-side; the
 * caller decides where it sits (the per-student results page, a monitor row)
 * and what happens after (`onDeleted`). `disabledReason` renders the button
 * disabled with that text as its title — the monitor uses it while the
 * student may still be locked in, mirroring the route's 409.
 */
export function DeleteAttemptControl({
  attemptId,
  studentName,
  onDeleted,
  disabledReason,
  size = "sm",
}: {
  attemptId: string;
  studentName: string;
  onDeleted: () => void;
  disabledReason?: string;
  size?: "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/attempts/${attemptId}`, { method: "DELETE" });
      if (!res.ok) throw await readError(res);
      setOpen(false);
      onDeleted();
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
        Delete attempt
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {studentName}&apos;s attempt?</AlertDialogTitle>
            <AlertDialogDescription>
              Every answer, drawing, score and session event for this attempt is removed. This
              cannot be undone. The student starts fresh the next time they join this test.
            </AlertDialogDescription>
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
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {busy ? "Deleting…" : "Delete attempt"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
