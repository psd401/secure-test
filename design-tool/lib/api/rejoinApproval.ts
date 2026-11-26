/**
 * Rejoin approval (docs/working-time-clock-design.md, D2, slice 3).
 *
 * On a working-time test the clock pauses while a student is out of the test,
 * so leaving and coming back must not be the student's own call: coming back
 * into the SAME sitting after leaving it (a quit, a crash, a relaunch — Q2)
 * waits for the teacher's "Let back in", as College Board and state test apps
 * do. What does NOT need it (James, 2026-11-25):
 *   - 3.2 the first join to a sitting — a new session is the teacher's
 *     approval, so day 2 of a multi-day test is not 30 clicks;
 *   - 3.1 the first join after a pass back — the pass back is the approval
 *     (it clears `last_join_session_id`);
 *   - a reload mid-session (ticked within `MID_SESSION_SECONDS`);
 *   - 3.3 a client without `X-SecureTest-Version` (≤ v1.4.0), which dead-ends
 *     on a 409 — the same exemption as the time-up refusal (EX-2).
 * Practice attempts are the teacher's own and never wait.
 *
 * An approval lasts `REJOIN_APPROVAL_SECONDS` (Q3: 10 minutes) and is used
 * up by the join it admits.
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { attempt_events, attempts, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import type { DeadlineAssessment } from "@/lib/api/attemptDeadline";
import { onWorkingClock } from "@/lib/api/workingClock";

type Db = ReturnType<typeof getDb>;

/** Q3: how long a "Let back in" stays usable. */
export const REJOIN_APPROVAL_SECONDS = 600;

/** A join this soon after the last tick is a reload inside the session, not a
 * rejoin: the client polls every 5 s, so a live session is never this stale. */
export const MID_SESSION_SECONDS = 60;

type RejoinFields = Pick<
  AttemptRow,
  | "status"
  | "time_limit_removed"
  | "practice"
  | "test_session_id"
  | "last_join_session_id"
  | "last_tick_at"
  | "rejoin_approved_until"
>;

/** Does joining now need the teacher's approval? Pure for the tests. */
export function needsRejoinApproval(
  attempt: RejoinFields,
  assessment: DeadlineAssessment,
  now: Date = new Date(),
): boolean {
  if (attempt.practice || !onWorkingClock(attempt, assessment)) return false;
  // 3.1 / 3.2: the first join to this sitting (or since a pass back) is free.
  if (attempt.test_session_id === null || attempt.last_join_session_id !== attempt.test_session_id) {
    return false;
  }
  // A reload mid-session.
  if (
    attempt.last_tick_at &&
    now.getTime() - attempt.last_tick_at.getTime() <= MID_SESSION_SECONDS * 1000
  ) {
    return false;
  }
  return !(attempt.rejoin_approved_until && attempt.rejoin_approved_until > now);
}

/**
 * The delivery route's join gate. Refuses with 409 `rejoin_needs_approval`
 * (recording the request once, for the Monitor) when the join needs approval
 * and the client can show the refusal (`enforce`); otherwise admits it:
 * records the sitting joined, uses up any approval, clears any request.
 * Locked, so two concurrent joins cannot both use one approval.
 */
export async function admitJoin(
  db: Db,
  attempt: AttemptRow,
  assessment: DeadlineAssessment,
  opts: { enforce: boolean },
  now: Date = new Date(),
): Promise<NextResponse | null> {
  if (attempt.status !== "in_progress") return null;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.id, attempt.id))
      .for("update");
    if (!current || current.status !== "in_progress") return null;

    if (opts.enforce && needsRejoinApproval(current, assessment, now)) {
      if (current.rejoin_requested_at === null) {
        await tx
          .update(attempts)
          .set({ rejoin_requested_at: now })
          .where(eq(attempts.id, current.id));
        await tx.insert(attempt_events).values({
          attempt_id: current.id,
          kind: "rejoin_requested",
          at: now,
          detail: {},
        });
      }
      return NextResponse.json({ ok: false, error: "rejoin_needs_approval" }, { status: 409 });
    }

    // Admitted. Written only when something changes, so a reload mid-session
    // stays read-only here.
    if (
      current.last_join_session_id !== current.test_session_id ||
      current.rejoin_approved_until !== null ||
      current.rejoin_requested_at !== null
    ) {
      await tx
        .update(attempts)
        .set({
          last_join_session_id: current.test_session_id,
          rejoin_approved_until: null,
          rejoin_requested_at: null,
        })
        .where(eq(attempts.id, current.id));
    }
    return null;
  });
}

/** The teacher's "Let back in": an approval for the next join, for 10 min. */
export async function approveRejoin(
  db: Db,
  attempt: AttemptRow,
  staffSub: string,
  now: Date = new Date(),
): Promise<AttemptRow> {
  const until = new Date(now.getTime() + REJOIN_APPROVAL_SECONDS * 1000);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(attempts)
      .set({ rejoin_approved_until: until, updated_at: now })
      .where(eq(attempts.id, attempt.id))
      .returning();
    await tx.insert(attempt_events).values({
      attempt_id: attempt.id,
      kind: "rejoin_approved",
      at: now,
      detail: { by: staffSub, until: until.toISOString() },
    });
    return row!;
  });
}
