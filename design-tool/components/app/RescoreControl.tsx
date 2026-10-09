"use client";

import { useEffect, useState } from "react";
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
import {
  RESCORE_NOTHING_TITLE,
  doneLine,
  dryRunSummary,
  questionLine,
  rescoreButtonLabel,
  rescoreDoneKey,
  rescoreErrorMessage,
  sentBeforeLine,
  type RescoreDone,
  type RescoreDryRun,
} from "@/lib/scoring/rescoreDialog";

async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }
  return `http_${res.status}`;
}

/**
 * "Rescore with current key (n)" on the Results page
 * (docs/rescore-after-key-change-design.md, E11, D-1). `studentsChanged` is
 * `buildResults().rescore_students`: 0 disables the button. Press → dry run →
 * a confirm listing the questions → the write → `onDone`, which the results
 * page turns into a reload. The result line rides the reload in
 * sessionStorage and shows once.
 */
export function RescoreControl({
  assessmentId,
  studentsChanged,
  onDone,
}: {
  assessmentId: string;
  studentsChanged: number;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dry, setDry] = useState<RescoreDryRun | null>(null);
  const [done, setDone] = useState<RescoreDone | null>(null);

  useEffect(() => {
    try {
      const key = rescoreDoneKey(assessmentId);
      const raw = window.sessionStorage.getItem(key);
      if (raw) {
        window.sessionStorage.removeItem(key);
        setDone(JSON.parse(raw) as RescoreDone);
      }
    } catch {
      // storage blocked: the scores on the page are the record
    }
  }, [assessmentId]);

  async function preview() {
    setBusy(true);
    setError(null);
    setDry(null);
    setOpen(true);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/rescore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dry_run: true }),
      });
      if (!res.ok) {
        setError(rescoreErrorMessage(await errorCode(res)));
        return;
      }
      setDry((await res.json()) as RescoreDryRun);
    } catch {
      setError(rescoreErrorMessage("network"));
    } finally {
      setBusy(false);
    }
  }

  async function rescore() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/rescore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dry_run: false }),
      });
      if (!res.ok) {
        setError(rescoreErrorMessage(await errorCode(res)));
        return;
      }
      const body = (await res.json()) as Omit<RescoreDone, "at">;
      const result: RescoreDone = {
        written: body.written,
        students_changed: body.students_changed,
        sections_sent_before: body.sections_sent_before ?? [],
        at: new Date().toISOString(),
      };
      try {
        window.sessionStorage.setItem(rescoreDoneKey(assessmentId), JSON.stringify(result));
      } catch {
        // storage blocked: the reloaded page still shows the new scores
      }
      setOpen(false);
      setDone(result);
      onDone?.();
    } catch {
      setError(rescoreErrorMessage("network"));
    } finally {
      setBusy(false);
    }
  }

  const sentLine = done ? sentBeforeLine(done.sections_sent_before) : null;
  const canRescore = dry !== null && dry.students_changed > 0;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={studentsChanged === 0}
        title={studentsChanged === 0 ? RESCORE_NOTHING_TITLE : undefined}
        onClick={() => void preview()}
      >
        {rescoreButtonLabel(studentsChanged)}
      </Button>
      {done ? (
        <p role="status" className="basis-full text-sm text-muted-foreground">
          {doneLine(done)}
          {sentLine ? <span className="ml-1 text-foreground">{sentLine}</span> : null}
        </p>
      ) : null}
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rescore with the current answer keys?</AlertDialogTitle>
            <AlertDialogDescription>
              {dry ? dryRunSummary(dry) : busy ? "Checking the handed-in answers…" : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dry && dry.questions.length > 0 ? (
            <ul className="list-disc pl-5 text-sm">
              {dry.questions.map((q) => (
                <li key={q.position}>{questionLine(q)}</li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{canRescore ? "Cancel" : "Close"}</AlertDialogCancel>
            {canRescore ? (
              <AlertDialogAction
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  void rescore();
                }}
              >
                {busy ? "Rescoring…" : "Rescore"}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
