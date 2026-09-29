/**
 * Change a final score (docs/change-score-design.md, D-1): correct in place and
 * keep the old number as a record.
 *
 * Shaped like `lib/api/passBackAttempt.ts`: the WRITE lives here, the refusals
 * that need a request (access, body, the item's max) belong to the route. The
 * one refusal made here is `no_final`, because only inside the transaction is
 * "the current final" a fact rather than a guess.
 *
 * One transaction, because the three writes are one fact. The flip without the
 * insert leaves the response unscored (it would read "awaiting scoring" and a
 * gradebook send would hold the student back — the reason option B was
 * rejected); the insert without the flip would leave two finals (nothing in
 * the DB forbids it — `final` is enforced by the routes, not an index).
 *
 * Any final, whatever its method (D-2): an auto-scored MC cell, an approved AI
 * proposal and a hand score are all corrected the same way. The new row is
 * always `human` — the teacher's number stands — and AI feedback is NOT re-run
 * (4.2): the old row's rationale is superseded with it.
 *
 * The link from the new row back to the old one is `rationale.changed_from`,
 * which is what `lib/scoring/supersededScores.ts` reads to tell a changed score
 * from one set aside by a pass back.
 */

import { and, eq } from "drizzle-orm";
import { attempt_events, scores, type ScoreRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import type { ChangeScoreBody } from "@/lib/api/reviewActions";

type Db = ReturnType<typeof getDb>;

export interface ChangeScoreTarget {
  response_id: string;
  attempt_id: string;
  item_id: string;
}

export type ChangeScoreResult =
  | { ok: true; score: ScoreRow; replaced: ScoreRow }
  | { ok: false; error: "no_final" };

export async function changeFinalScore(
  db: Db,
  target: ChangeScoreTarget,
  body: ChangeScoreBody,
  staffSub: string,
  options: { now?: Date } = {},
): Promise<ChangeScoreResult> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    // The flip IS the read: `status = 'final'` in the WHERE means two
    // concurrent changes cannot both supersede the same row — the loser flips
    // nothing and answers `no_final`, the same answer as a response that was
    // never scored (the caller re-reads and tries again).
    const [replaced] = await tx
      .update(scores)
      .set({ status: "superseded" })
      .where(
        and(eq(scores.response_id, target.response_id), eq(scores.status, "final")),
      )
      .returning();
    if (!replaced) return { ok: false, error: "no_final" } as const;

    const [created] = await tx
      .insert(scores)
      .values({
        response_id: target.response_id,
        method: "human",
        points: body.points,
        max_points: body.max_points,
        rationale: {
          ...(body.criterion_scores ? { criterion_scores: body.criterion_scores } : {}),
          ...(body.reason ? { note: body.reason } : {}),
          changed_from: {
            score_id: replaced.id,
            points: replaced.points,
            method: replaced.method,
            scorer: replaced.scorer,
          },
        },
        scorer: staffSub,
        status: "final",
        reviewed_by_sub: staffSub,
        created_at: now,
      })
      .returning();

    await tx.insert(attempt_events).values({
      attempt_id: target.attempt_id,
      kind: "score_changed",
      at: now,
      detail: {
        response_id: target.response_id,
        item_id: target.item_id,
        from: replaced.points,
        to: body.points,
        max: body.max_points,
      },
    });

    return { ok: true, score: created!, replaced };
  });
}
