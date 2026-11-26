/**
 * Working-time clock (docs/working-time-clock-design.md): the tick that counts
 * time spent in a test.
 *
 * Called by the two requests a student's app makes during a test: the
 * delivery request when it joins (`join: true`) and the 5 s peek poll during
 * the session (`join: false`). A join only moves `last_tick_at` to now: the
 * time since the last tick was spent outside the test (between sessions, or
 * a quit and relaunch), however short, and is never counted. A poll adds the
 * time since the last tick when that gap is within `CLOCK_GAP_CAP_SECONDS`
 * (2 min); a longer gap inside a session is the network or a deploy (Q4), so
 * it is not counted and is logged as `clock_gap`.
 *
 * Only an in-progress attempt on a working-time limit is written; every other
 * attempt (untimed, wall clock, limit removed, handed in) returns untouched,
 * so the poll stays read-only for them. The row is locked for the read-modify-
 * write, so two overlapping polls cannot count the same seconds twice.
 */

import { eq } from "drizzle-orm";
import { attempt_events, attempts, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import { CLOCK_GAP_CAP_SECONDS, type DeadlineAssessment } from "@/lib/api/attemptDeadline";

type Db = ReturnType<typeof getDb>;

/** Does this attempt run on the working-time clock right now? */
export function onWorkingClock(
  attempt: Pick<AttemptRow, "status" | "time_limit_removed">,
  assessment: DeadlineAssessment,
): boolean {
  return (
    attempt.status === "in_progress" &&
    !attempt.time_limit_removed &&
    (assessment.time_limit_seconds ?? 0) > 0 &&
    assessment.time_limit_mode === "working"
  );
}

export async function tickWorkingClock(
  db: Db,
  attempt: AttemptRow,
  assessment: DeadlineAssessment,
  opts: { join: boolean },
  now: Date = new Date(),
): Promise<AttemptRow> {
  if (!onWorkingClock(attempt, assessment)) return attempt;
  return db.transaction(async (tx) => {
    // The locked row is the only source of the running total: the caller's
    // `attempt` may be a stale copy, and writing it back would lose seconds.
    const [current] = await tx
      .select({
        working_seconds: attempts.working_seconds,
        last_tick_at: attempts.last_tick_at,
        status: attempts.status,
      })
      .from(attempts)
      .where(eq(attempts.id, attempt.id))
      .for("update");
    if (!current || current.status !== "in_progress") return attempt;
    const gapMs = current.last_tick_at ? now.getTime() - current.last_tick_at.getTime() : null;
    const capMs = CLOCK_GAP_CAP_SECONDS * 1000;
    const counted =
      !opts.join && gapMs !== null && gapMs >= 0 && gapMs <= capMs ? gapMs / 1000 : 0;
    if (!opts.join && gapMs !== null && gapMs > capMs) {
      await tx.insert(attempt_events).values({
        attempt_id: attempt.id,
        kind: "clock_gap",
        at: now,
        detail: { seconds: Math.round(gapMs / 1000) },
      });
    }
    const [row] = await tx
      .update(attempts)
      .set({ working_seconds: current.working_seconds + counted, last_tick_at: now })
      .where(eq(attempts.id, attempt.id))
      .returning();
    return row!;
  });
}
