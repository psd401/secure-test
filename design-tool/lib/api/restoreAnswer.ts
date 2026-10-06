// Answer history slice 2 (docs/answer-history-design.md): make an earlier
// version of a text answer the current one.
//
// One transaction:
//   1. the current value is kept first (reason `restored`) unless it is blank
//      or already the version being restored — so a restore can itself be
//      undone from the same list;
//   2. the version is written as the answer (`updated_at` = now, so a later
//      hand-in screens it again for safeguarding);
//   3. on a handed-in attempt, the answer's `final` and `proposed` scores are
//      superseded — they scored the text that was replaced. The restored
//      answer is left for the teacher to score (James, 2026-10-06, 5.3);
//   4. an `answer_restored` event for the timeline.
//
// Who may, and when, is the route's business (edit level; refused while an
// open sitting holds the attempt).

import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  attempt_events,
  response_revisions,
  responses,
  scores,
  type AttemptRow,
  type ResponseRevisionRow,
  type ResponseRow,
} from "@/db/schema";
import { answerLength } from "@/lib/api/answerHistory";

type Db = ReturnType<typeof getDb>;

export interface RestoreAnswerResult {
  response: ResponseRow;
  /** The version was already the current answer; nothing changed. */
  unchanged: boolean;
  /** Scores set aside because they scored the replaced text. */
  superseded_scores: number;
}

export async function restoreAnswerVersion(
  db: Db,
  attempt: AttemptRow,
  revision: ResponseRevisionRow,
  options: { now?: Date } = {},
): Promise<RestoreAnswerResult> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(responses)
      .where(
        and(eq(responses.attempt_id, attempt.id), eq(responses.item_id, revision.item_id)),
      )
      .for("update")
      .limit(1);

    if (current && JSON.stringify(current.response) === JSON.stringify(revision.response)) {
      return { response: current, unchanged: true, superseded_scores: 0 };
    }

    if (current && answerLength(current.response) > 0) {
      await tx.insert(response_revisions).values({
        attempt_id: attempt.id,
        item_id: revision.item_id,
        response: current.response,
        saved_at: current.updated_at,
        captured_at: now,
        reason: "restored",
      });
    }

    const [written] = await tx
      .insert(responses)
      .values({
        attempt_id: attempt.id,
        item_id: revision.item_id,
        response: revision.response,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [responses.attempt_id, responses.item_id],
        set: { response: revision.response, updated_at: now },
      })
      .returning();

    let supersededIds: string[] = [];
    if (current && attempt.status === "submitted") {
      const flipped = await tx
        .update(scores)
        .set({ status: "superseded" })
        .where(
          and(
            eq(scores.response_id, current.id),
            inArray(scores.status, ["final", "proposed"]),
          ),
        )
        .returning({ id: scores.id });
      supersededIds = flipped.map((r) => r.id);
    }

    await tx.insert(attempt_events).values({
      attempt_id: attempt.id,
      kind: "answer_restored",
      at: now,
      detail: {
        response_id: written!.id,
        item_id: revision.item_id,
        revision_id: revision.id,
        saved_at: revision.saved_at.toISOString(),
        superseded_score_ids: supersededIds,
      },
    });

    return { response: written!, unchanged: false, superseded_scores: supersededIds.length };
  });
}
