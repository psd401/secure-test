// Instant feedback (docs/instant-feedback-design.md, slice 1): the DB half —
// load one attempt's items, responses and FINAL scores and hand them to the
// pure builder. Called by the submit route AFTER `runAutoScoringPass`, so the
// finals it reads are the ones just written.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { attempt_events, items, responses, scores } from "@/db/schema";
import { answersShown, buildFeedback, type Feedback, type FeedbackSettings } from "./buildFeedback";

type Db = ReturnType<typeof getDb>;

export async function feedbackForAttempt(
  db: Db,
  attempt: { id: string; assessment_id: string },
  settings: FeedbackSettings,
): Promise<Feedback | null> {
  if (settings.student_feedback === "off") return null;
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, attempt.assessment_id))
    .orderBy(asc(items.position));
  const responseRows = await db
    .select()
    .from(responses)
    .where(eq(responses.attempt_id, attempt.id));
  const finalRows =
    responseRows.length > 0
      ? await db
          .select()
          .from(scores)
          .where(
            and(
              inArray(
                scores.response_id,
                responseRows.map((r) => r.id),
              ),
              // Finals only: a proposed AI score is not a result (the results
              // matrix's rule), and research rows are invisible everywhere.
              eq(scores.status, "final"),
            ),
          )
      : [];
  const itemByResponse = new Map(responseRows.map((r) => [r.id, r.item_id]));
  const finals = new Map<string, { points: number; max_points: number }>();
  for (const s of finalRows) {
    const itemId = itemByResponse.get(s.response_id);
    if (itemId) finals.set(itemId, { points: s.points, max_points: s.max_points });
  }
  return buildFeedback({
    settings,
    items: itemRows,
    responses: new Map(
      responseRows.map((r) => [r.item_id, r.response as Record<string, unknown>]),
    ),
    finals,
  });
}

/** D-5: record what was shown — one `feedback_shown` row per shown feedback. */
export async function recordFeedbackShown(
  db: Db,
  attemptId: string,
  feedback: Feedback,
  settings: FeedbackSettings,
): Promise<void> {
  await db.insert(attempt_events).values({
    attempt_id: attemptId,
    kind: "feedback_shown",
    detail: {
      level: feedback.level,
      earned: feedback.earned,
      max_auto: feedback.max_auto,
      answers_shown: answersShown(settings),
    },
  });
}

/** Has this attempt's hand-in already been shown feedback? */
export async function feedbackWasShown(db: Db, attemptId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: attempt_events.id })
    .from(attempt_events)
    .where(and(eq(attempt_events.attempt_id, attemptId), eq(attempt_events.kind, "feedback_shown")))
    .limit(1);
  return row !== undefined;
}
