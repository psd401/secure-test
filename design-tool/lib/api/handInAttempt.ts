/**
 * The teacher's forced hand-in, as one operation on one attempt.
 *
 * Extracted from `POST /api/attempts/[attemptId]/hand-in` when "Hand in
 * everyone now" (the sitting-wide button) needed to do the identical thing to
 * every in-progress attempt in a sitting. Two copies of "what handing in
 * means" would drift: one of them would eventually stop writing the
 * `teacher_hand_in` row, or stop auto-scoring, and the difference would only
 * show up in a family's integrity timeline months later.
 *
 * Deliberately NOT included here: the refusals. Whether this attempt may be
 * handed in at all — owner, status, sitting, deadline — is the caller's
 * decision, because the two callers answer it differently (one 409s, the other
 * skips the row and carries on). This function is the write.
 */

import { eq } from "drizzle-orm";
import { attempt_events, attempts, type AttemptRow } from "@/db/schema";
import { runAutoScoringPass } from "@/lib/scoring/runAutoScoring";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export interface HandInResult {
  attempt: AttemptRow;
  scored: number;
}

export async function handInAttempt(
  db: Db,
  attempt: AttemptRow,
  staffSub: string,
  now: Date = new Date(),
): Promise<HandInResult> {
  const [row] = await db
    .update(attempts)
    .set({
      status: "submitted",
      submitted_at: now,
      submitted_by_sub: staffSub,
      updated_at: now,
    })
    .where(eq(attempts.id, attempt.id))
    .returning();

  // The audit trail a family may ask about later: the integrity timeline says
  // the teacher ended this attempt, next to the `time_expired` row that says
  // why.
  await db.insert(attempt_events).values({
    attempt_id: attempt.id,
    kind: "teacher_hand_in",
    at: now,
  });

  // A scoring failure must never fail the hand-in (the pass is idempotent and
  // re-runnable) — and in the sitting-wide caller it must never fail the other
  // students' hand-ins either.
  let scored = 0;
  try {
    const summary = await runAutoScoringPass(db, row!);
    scored = summary.scored;
  } catch (err) {
    console.error("hand-in: auto-scoring failed", err);
  }

  return { attempt: row!, scored };
}
