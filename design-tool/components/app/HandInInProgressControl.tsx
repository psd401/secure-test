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

function students(n: number): string {
  return `${n} student${n === 1 ? "" : "s"}`;
}

/** The button's label: the count it will hand in. Pure, for the tests. */
export function handInInProgressLabel(ready: number): string {
  return `Hand in all in progress (${ready})`;
}

/**
 * The confirm dialog's body (roadmap U-14). Pure and exported because Radix
 * unmounts the dialog content while it is closed, so static markup cannot
 * reach it — the same reason `handInAllDialogCopy` is.
 *
 * `held` = in-progress rows on the page that this press will NOT touch,
 * because their test session is still open and their time has not run out.
 */
export function handInInProgressDialogCopy(
  ready: number,
  held: number,
  sectionLabel: string | null,
): string {
  const where = sectionLabel ? ` in ${sectionLabel}` : "";
  let text =
    `Hand in ${students(ready)}${where} who ${ready === 1 ? "hasn't" : "haven't"} finished? Their answers are ` +
    "saved as they are, they can't continue, and the work goes to scoring. " +
    "This can't be undone.";
  if (held > 0) {
    text +=
      ` ${students(held)} still in an open test session ${held === 1 ? "is" : "are"} ` +
      "left alone; close that session first to include them.";
  }
  return text;
}

/**
 * "Hand in all in progress" on the Results page
 * (POST /api/assessments/[id]/hand-in). Hands in the in-progress rows the
 * page is showing — whichever sessions they last joined — so a test run over
 * several class periods can be finalised in one press. The server re-checks
 * every id with the per-attempt rules.
 */
export function HandInInProgressControl({
  assessmentId,
  readyAttemptIds,
  heldCount,
  sectionLabel,
  onHandedIn,
}: {
  assessmentId: string;
  /** In-progress rows on the page that may be handed in now. */
  readyAttemptIds: string[];
  /** In-progress rows held back by an open session. */
  heldCount: number;
  sectionLabel: string | null;
  onHandedIn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = readyAttemptIds.length;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/hand-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attempt_ids: readyAttemptIds }),
      });
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
        size="sm"
        disabled={ready === 0}
        title={
          ready === 0
            ? "Everyone still working is in an open test session. Close it first, then hand in."
            : undefined
        }
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {handInInProgressLabel(ready)}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hand in all in progress?</AlertDialogTitle>
            <AlertDialogDescription>
              {handInInProgressDialogCopy(ready, heldCount, sectionLabel)}
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
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {busy ? "Handing in…" : `Hand in ${students(ready)}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
