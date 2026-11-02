/**
 * Corrections mode marks and locks (docs/bulk-pass-back-and-corrections-design.md,
 * slice 3, D-21…D-24): how each question went on the hand-in that was just
 * passed back, as a word, and which questions are locked because they earned
 * full credit.
 *
 * The round (D-24) is the one `attempts.corrections.passed_back_at` closes:
 * after the previous `passed_back` event (or the start), up to and including
 * this one. Per answer that existed then, the LAST `final` or `superseded`
 * score in the round decides — the same reading `lib/scoring/attemptOne.ts`
 * gives attempt 1, applied to the latest round. An unreviewed AI final counts
 * (D-22); `proposed` and `research` never do. An answer with no score in the
 * round, or an unanswered question, gets no mark and stays open (D-23).
 *
 * The word follows `buildFeedback`'s rule (full points correct, none
 * incorrect, else partial), against the score row's own `max_points`.
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import { attempt_events, responses, scores, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export type CorrectionMark = "correct" | "partial" | "incorrect";

export interface CorrectionsPayload {
  marks?: Record<string, CorrectionMark>;
  locked?: string[];
}

export interface RoundResponse {
  id: string;
  item_id: string;
  created_at: Date;
}
export interface RoundScore {
  response_id: string;
  status: string;
  points: number;
  max_points: number;
  created_at: Date;
}

export function markFor(points: number, max: number): CorrectionMark {
  if (points >= max) return "correct";
  if (points <= 0) return "incorrect";
  return "partial";
}

/** The rule on one attempt's rows. Pure for the tests. */
export function correctionsFromRound(
  options: { show_marks: boolean; lock_correct: boolean },
  roundStart: Date | null,
  roundEnd: Date,
  responseRows: readonly RoundResponse[],
  scoreRows: readonly RoundScore[],
): CorrectionsPayload {
  const start = roundStart?.getTime() ?? -Infinity;
  const end = roundEnd.getTime();
  const marks: Record<string, CorrectionMark> = {};
  for (const r of responseRows) {
    if (r.created_at.getTime() > end) continue;
    const last = scoreRows
      .filter(
        (s) =>
          s.response_id === r.id &&
          (s.status === "final" || s.status === "superseded") &&
          s.created_at.getTime() > start &&
          s.created_at.getTime() <= end,
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    if (last) marks[r.item_id] = markFor(last.points, last.max_points);
  }
  const locked = Object.entries(marks)
    .filter(([, m]) => m === "correct")
    .map(([id]) => id)
    .sort();
  return {
    ...(options.show_marks && Object.keys(marks).length > 0 ? { marks } : {}),
    ...(options.lock_correct && locked.length > 0 ? { locked } : {}),
  };
}

/** `correctionsFromRound` for one attempt, or null when it asked for
 * nothing or the result is empty. */
export async function loadCorrections(
  db: Db,
  attempt: Pick<AttemptRow, "id" | "corrections">,
): Promise<CorrectionsPayload | null> {
  const c = attempt.corrections;
  if (!c || (!c.show_marks && !c.lock_correct)) return null;
  const end = new Date(c.passed_back_at);

  const passBacks = await db
    .select({ at: attempt_events.at })
    .from(attempt_events)
    .where(and(eq(attempt_events.attempt_id, attempt.id), eq(attempt_events.kind, "passed_back")));
  const earlier = passBacks
    .map((e) => e.at)
    .filter((at) => at.getTime() < end.getTime())
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const responseRows = await db
    .select({ id: responses.id, item_id: responses.item_id, created_at: responses.created_at })
    .from(responses)
    .where(eq(responses.attempt_id, attempt.id));
  const scoreRows =
    responseRows.length > 0
      ? await db
          .select({
            response_id: scores.response_id,
            status: scores.status,
            points: scores.points,
            max_points: scores.max_points,
            created_at: scores.created_at,
          })
          .from(scores)
          .where(
            and(
              inArray(
                scores.response_id,
                responseRows.map((r) => r.id),
              ),
              ne(scores.status, "research"),
            ),
          )
      : [];

  const payload = correctionsFromRound(c, earlier ?? null, end, responseRows, scoreRows);
  return payload.marks || payload.locked ? payload : null;
}
