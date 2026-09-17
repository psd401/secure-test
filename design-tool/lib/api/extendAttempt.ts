/**
 * The teacher's time extension, as one operation on one attempt.
 *
 * Shaped like `lib/api/handInAttempt.ts` and for the same reason: two callers
 * (the per-attempt route and the sitting-wide one) have to do the identical
 * thing, and two copies of "what extending means" would drift until one of
 * them stopped writing the `deadline_extended` row and nobody could tell a
 * family why a child was still writing forty minutes after the buzzer.
 *
 * Deliberately NOT included here: the refusals. Whether this attempt may be
 * extended at all — owner, status, an instant that is actually in the future —
 * is the caller's decision, because the two callers answer it differently (one
 * 409s, the other skips the row and carries on). This function is the write.
 *
 * `deadline_override_at` REPLACES the computed deadline rather than adding to
 * it (see the column's comment in db/schema.ts), so re-applying the same
 * instant is a no-op in effect: the row is written again and a second event
 * recorded, but the deadline does not move. That makes the sitting-wide caller
 * safely idempotent — a teacher pressing "extend to 10:45" twice gets 10:45.
 */

import { eq } from "drizzle-orm";
import { attempt_events, attempts, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export interface ExtendResult {
  attempt: AttemptRow;
}

export async function extendAttempt(
  db: Db,
  attempt: AttemptRow,
  staffSub: string,
  endsAt: Date,
  now: Date = new Date(),
): Promise<ExtendResult> {
  const [row] = await db
    .update(attempts)
    .set({ deadline_override_at: endsAt, updated_at: now })
    .where(eq(attempts.id, attempt.id))
    .returning();

  // The audit trail: the integrity timeline says the teacher moved this
  // student's deadline, and to when. `by` is the staff sub, matching how
  // `attempts.submitted_by_sub` records the forced hand-in — the timeline
  // renders the words, not the sub, but the row has to be able to answer
  // "who" months later.
  await db.insert(attempt_events).values({
    attempt_id: attempt.id,
    kind: "deadline_extended",
    at: now,
    detail: { ends_at: endsAt.toISOString(), by: staffSub },
  });

  return { attempt: row! };
}
