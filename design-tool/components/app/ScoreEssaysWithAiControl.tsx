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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

// Score a section's essays with AI in one press (roadmap U-24,
// docs/batch-ai-scoring-design.md). The browser runs the batch: one POST to
// the attempt-wide score-ai route per student, CONCURRENCY at a time, so each
// request stays far under the load balancer's 120 s idle timeout and a failed
// student does not stop the rest. The route skips essays already scored and
// withholds flagged answers, so pressing again after a closed tab or a failure
// picks up only what is left.

/** D-5: three students at a time, like the Google Docs send. */
export const CONCURRENCY = 3;

function essays(n: number): string {
  return `${n} written answer${n === 1 ? "" : "s"}`;
}

function students(n: number): string {
  return `${n} student${n === 1 ? "" : "s"}`;
}

/** The button's label: the essays a press will send. Pure, for the tests. */
export function scoreEssaysLabel(n: number): string {
  return `Score written answers with AI (${n})`;
}

/** Why the button is disabled, or undefined when it is not (D-2). */
export function scoreEssaysDisabledReason(
  n: number,
  sectionChosen: boolean,
): string | undefined {
  if (!sectionChosen) return "Choose a section first.";
  if (n === 0) return "No written answers in this section are waiting for an AI score.";
  return undefined;
}

/** The confirm dialog's body. Pure: Radix unmounts it while closed. */
export function scoreEssaysDialogCopy(
  n: number,
  studentCount: number,
  sectionLabel: string,
): string {
  return (
    `Score ${essays(n)} from ${students(studentCount)} in ${sectionLabel} with AI? ` +
    "Each answer gets an AI proposal for you to review in the scoring queue; " +
    "on a Hybrid question a confident score counts without review. " +
    "Answers already scored are skipped. Keep this page open until it finishes."
  );
}

/** The score-ai route's counts that the summary reads. */
export type ScoreAiTally = {
  scored_proposed: number;
  scored_final: number;
  withheld: number;
  /**
   * Essays whose safety screen failed this run (SEC-05): not scored, not
   * flagged — unknown. Absent from routes before that change, so it reads
   * as 0.
   */
  screening_failed: number;
  blocked: number;
  provider_errors: number;
  skipped_unscorable: number;
  /**
   * Essays another request was already scoring (the claim in
   * docs/ai-score-concurrency-design.md, #55). Absent from routes before
   * that change, so it reads as 0.
   */
  in_progress: number;
  /** Students whose request failed outright (HTTP error or network). */
  failed_students: number;
  /**
   * Students the route refused for a reason a retry cannot fix (a 4xx other
   * than 429: access removed mid-batch, an attempt no longer handed in).
   */
  refused_students: number;
};

export const EMPTY_TALLY: ScoreAiTally = {
  scored_proposed: 0,
  scored_final: 0,
  withheld: 0,
  screening_failed: 0,
  blocked: 0,
  provider_errors: 0,
  skipped_unscorable: 0,
  in_progress: 0,
  failed_students: 0,
  refused_students: 0,
};

/** Adds one route response (or a failed request, `null`) to the tally. */
export function addToTally(
  tally: ScoreAiTally,
  body: unknown | null | typeof REFUSED,
): ScoreAiTally {
  if (body === null)
    return { ...tally, failed_students: tally.failed_students + 1 };
  if (body === REFUSED)
    return { ...tally, refused_students: tally.refused_students + 1 };
  const b = body as Partial<Record<keyof ScoreAiTally, unknown>>;
  const n = (k: keyof ScoreAiTally) =>
    typeof b[k] === "number" ? (b[k] as number) : 0;
  return {
    scored_proposed: tally.scored_proposed + n("scored_proposed"),
    scored_final: tally.scored_final + n("scored_final"),
    withheld: tally.withheld + n("withheld"),
    screening_failed: tally.screening_failed + n("screening_failed"),
    blocked: tally.blocked + n("blocked"),
    provider_errors: tally.provider_errors + n("provider_errors"),
    skipped_unscorable: tally.skipped_unscorable + n("skipped_unscorable"),
    in_progress: tally.in_progress + n("in_progress"),
    failed_students: tally.failed_students,
    refused_students: tally.refused_students,
  };
}

/** The summary shown when the batch ends: one line per non-zero outcome. */
export function scoreEssaysSummary(t: ScoreAiTally): string[] {
  const lines: string[] = [];
  const scored = t.scored_proposed + t.scored_final;
  if (scored > 0) {
    const parts: string[] = [];
    if (t.scored_proposed > 0) {
      parts.push(
        `${t.scored_proposed} waiting for your review in the scoring queue`,
      );
    }
    if (t.scored_final > 0)
      parts.push(`${t.scored_final} finalized by AI (Hybrid)`);
    lines.push(`${essays(scored)} scored — ${parts.join(", ")}.`);
  }
  if (t.withheld > 0) {
    lines.push(
      `${t.withheld} held back: ${t.withheld === 1 ? "it looks" : "they look"} like ` +
        `${t.withheld === 1 ? "it tries" : "they try"} to instruct the AI. Read ` +
        `${t.withheld === 1 ? "it" : "them"} in the scoring queue.`,
    );
  }
  if (t.screening_failed > 0) {
    lines.push(
      `${t.screening_failed} not scored: the safety check didn't answer, so ` +
        `${t.screening_failed === 1 ? "it was" : "they were"} skipped. Run Score with AI again later.`,
    );
  }
  if (t.in_progress > 0) {
    lines.push(
      `${t.in_progress} ${t.in_progress === 1 ? "was" : "were"} already being scored ` +
        "from another press — check the scoring queue in a minute.",
    );
  }
  if (t.blocked > 0) {
    lines.push(
      `${t.blocked} stopped by the AI safety filter — score ${t.blocked === 1 ? "it" : "them"} by hand.`,
    );
  }
  if (t.provider_errors > 0) {
    lines.push(
      `${t.provider_errors} couldn't be scored (the AI service didn't answer). ` +
        "Press the button again to retry.",
    );
  }
  if (t.failed_students > 0) {
    lines.push(
      `${t.failed_students} ${t.failed_students === 1 ? "student's" : "students'"} answers ` +
        "couldn't be sent. Press the button again to retry.",
    );
  }
  if (t.refused_students > 0) {
    lines.push(
      `${t.refused_students} ${t.refused_students === 1 ? "student's" : "students'"} answers ` +
        "couldn't be scored from this page. Reload it and check you can still edit this test.",
    );
  }
  if (t.skipped_unscorable > 0) {
    lines.push(
      `${t.skipped_unscorable} ${t.skipped_unscorable === 1 ? "has" : "have"} no rubric or ${t.skipped_unscorable === 1 ? "is" : "are"} empty.`,
    );
  }
  if (lines.length === 0) lines.push("Nothing was left to score.");
  return lines;
}

/**
 * Runs `worker` over `ids`, at most `limit` at a time, calling `onDone` after
 * each. Exported for the tests; the worker never throws (it reports `null`).
 */
export async function runPool<T>(
  ids: string[],
  limit: number,
  worker: (id: string) => Promise<T>,
  onDone: (result: T) => void,
): Promise<void> {
  let next = 0;
  async function lane() {
    while (next < ids.length) {
      const id = ids[next++]!;
      onDone(await worker(id));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, lane));
}

/** A request the route refused for good; pressing again would not help. */
export const REFUSED = "refused" as const;

/**
 * How one student's request ended, from its HTTP status: the route's body on
 * success, `null` when a retry may succeed (network, 429, 5xx), REFUSED for
 * any other status (403 / 404 access, 400 `attempt_not_submitted`).
 */
export function outcomeForStatus(
  status: number,
): "ok" | "retry" | typeof REFUSED {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status >= 500) return "retry";
  return REFUSED;
}

async function scoreOne(
  attemptId: string,
): Promise<unknown | null | typeof REFUSED> {
  try {
    const res = await fetch(`/api/attempts/${attemptId}/score-ai`, {
      method: "POST",
    });
    const outcome = outcomeForStatus(res.status);
    if (outcome === REFUSED) return REFUSED;
    if (outcome === "retry") return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * "Score written answers with AI (n)" on the Results page. `attemptIds` = the shown
 * section's handed-in attempts with at least one essay waiting; `essayCount`
 * = n, the sum over them.
 */
export function ScoreEssaysWithAiControl({
  attemptIds,
  essayCount,
  sectionLabel,
  onFinished,
}: {
  attemptIds: string[];
  essayCount: number;
  /** null = no section chosen (D-2: disabled). */
  sectionLabel: string | null;
  onFinished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [summary, setSummary] = useState<string[] | null>(null);
  const disabledReason = scoreEssaysDisabledReason(
    essayCount,
    sectionLabel !== null,
  );

  async function start() {
    setRunning(true);
    setDone(0);
    let tally = EMPTY_TALLY;
    await runPool(attemptIds, CONCURRENCY, scoreOne, (body) => {
      tally = addToTally(tally, body);
      setDone((d) => d + 1);
    });
    setRunning(false);
    setSummary(scoreEssaysSummary(tally));
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setSummary(null);
          setOpen(true);
          return;
        }
        if (running) return;
        setOpen(false);
        if (summary) onFinished();
      }}
    >
      {/* G-3 pattern: the trigger, so Radix returns focus to it on close. */}
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabledReason !== undefined}
          title={disabledReason}
        >
          {scoreEssaysLabel(essayCount)}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {summary ? "AI scoring finished" : "Score written answers with AI?"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {summary ? (
                <ul className="space-y-1">
                  {summary.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : running ? (
                <p role="status">
                  Scoring… {done} of {students(attemptIds.length)} done.
                </p>
              ) : (
                <p>
                  {scoreEssaysDialogCopy(
                    essayCount,
                    attemptIds.length,
                    sectionLabel ?? "",
                  )}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {summary ? (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setOpen(false);
                onFinished();
              }}
            >
              Done
            </AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={running}
                onClick={(e) => {
                  e.preventDefault();
                  void start();
                }}
              >
                {running ? "Scoring…" : `Score ${essays(essayCount)}`}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
