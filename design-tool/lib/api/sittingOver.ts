/**
 * Close session ends the sitting (docs/close-session-ends-attempts-design.md,
 * D-1…D-3).
 *
 * One place decides whether an attempt's SITTING is over, because the same
 * three student-plane writes that ask about the time limit have to ask about
 * this too: the response write, the drawing-slot completion, and the student's
 * own submit. Teachers press **Close session** expecting the test to stop; a
 * rule enforced on two of the three doors is not a rule.
 *
 * What "over" means is deliberately identical to the rule the join and redeem
 * routes already apply (`loadJoinableSitting`): closed OR expired. "This
 * period · 55 min" means the period, so expiry needs no timer of its own — it
 * is read lazily by whatever the client sends next (D-2).
 *
 * What this does NOT do is end the ATTEMPT. The attempt stays `in_progress`
 * and resumable through a later sitting (finding 8.2 rebinds it); finalising
 * stays the teacher's hand-in or the student's own Finish in that later
 * session (D-1). So there is no status write here — only a refusal.
 *
 * Grace (D-3 as amended 2026-09-16): the WRITE guards accept for
 * SITTING_CLOSE_GRACE_SECONDS after the close or expiry instant; the peek poll
 * and the student's own submit do not. The client learns "closed" from the
 * poll within 5 s, flushes the field the student was typing in, and goes home
 * — that flush arrived after the close and was refused in the 2026-09-16
 * real-session run, losing the last words of an essay. Ten seconds covers the
 * poll interval plus the flush; it is invisible to the teacher because the
 * client is already on its way home when the write lands. The deadline's
 * 30 s (attemptDeadline.ts) is the same idea for the other clock.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { test_sessions, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

/** How long after Close / expiry a student-plane WRITE is still accepted. */
export const SITTING_CLOSE_GRACE_SECONDS = 10;

export interface OverSitting {
  status: string;
  expires_at: Date;
  /** The close instant — the close route stamps it. Absent = closed forever. */
  updated_at?: Date;
}

/**
 * Is this sitting closed or expired — as of `graceSeconds` after the fact?
 *
 * With no grace (the default; the poll and submit), expiry is `<= now` rather
 * than `< now`: `loadJoinableSitting` admits a sitting only while
 * `expires_at > now`, and the two must not disagree about the single instant
 * at the boundary — a sitting nobody may join is over. With a grace, a closed
 * sitting counts as over from `updated_at + grace` (the close route stamps
 * `updated_at` at the moment of Close) and an expired one from
 * `expires_at + grace`.
 */
export function sittingIsOver(
  sitting: OverSitting,
  now: Date = new Date(),
  graceSeconds = 0,
): boolean {
  const graceMs = graceSeconds * 1000;
  if (sitting.status !== "open") {
    if (graceMs <= 0 || !sitting.updated_at) return true;
    return now.getTime() >= sitting.updated_at.getTime() + graceMs;
  }
  return sitting.expires_at.getTime() + graceMs <= now.getTime();
}

/**
 * The student-plane guard: the 409 body when this attempt's sitting is over,
 * or null when the write may proceed.
 *
 * An attempt with NO `test_session_id` is untouched and returns null: the
 * `--token` dev posture and the seeder make attempts without a sitting, and
 * an attempt whose sitting row was deleted has its column set to null rather
 * than losing the work. Nothing governs those, so nothing refuses them.
 *
 * Returned rather than thrown, matching `refuseIfPastDeadline`, so each route
 * keeps the order of its checks visible — this one belongs after the attempt
 * is proven to be the caller's and to accept writes, and before the deadline.
 * The response / upload routes take the default grace; submit passes 0 — a
 * student's own hand-in after Close stays refused (D-1: finalising is the
 * teacher's).
 */
export async function refuseIfSittingOver(
  db: Db,
  attempt: AttemptRow,
  now: Date = new Date(),
  graceSeconds: number = SITTING_CLOSE_GRACE_SECONDS,
): Promise<NextResponse | null> {
  const over = await attemptSittingIsOver(db, attempt, now, graceSeconds);
  if (!over) return null;
  return NextResponse.json({ ok: false, error: "sitting_closed" }, { status: 409 });
}

/**
 * Is the sitting this attempt was last joined through over? False when the
 * attempt has no sitting at all (see `refuseIfSittingOver`) — shared with the
 * peek poll, which reports the same answer as `sitting: "open" | "closed"`
 * (D-5) rather than refusing.
 */
export async function attemptSittingIsOver(
  db: Db,
  attempt: AttemptRow,
  now: Date = new Date(),
  graceSeconds = 0,
): Promise<boolean> {
  if (!attempt.test_session_id) return false;
  const [sitting] = await db
    .select({
      status: test_sessions.status,
      expires_at: test_sessions.expires_at,
      updated_at: test_sessions.updated_at,
    })
    .from(test_sessions)
    .where(eq(test_sessions.id, attempt.test_session_id))
    .limit(1);
  // A missing row cannot happen (the FK is SET NULL on delete), but a sitting
  // that is somehow unreadable is not grounds for discarding a student's work.
  if (!sitting) return false;
  return sittingIsOver(sitting, now, graceSeconds);
}
