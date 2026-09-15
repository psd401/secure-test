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
 * No grace, unlike the deadline's 30 seconds (D-3). The autosave already in
 * flight when the teacher pressed Close can be lost — the one field the
 * student was typing in. Accepted deliberately: a Close that keeps taking
 * answers for half a minute is the behaviour teachers reported as wrong.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { test_sessions, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export interface OverSitting {
  status: string;
  expires_at: Date;
}

/**
 * Is this sitting closed or expired?
 *
 * Expiry is `<= now` rather than `< now`: `loadJoinableSitting` admits a
 * sitting only while `expires_at > now`, and the two must not disagree about
 * the single instant at the boundary — a sitting nobody may join is over.
 */
export function sittingIsOver(sitting: OverSitting, now: Date = new Date()): boolean {
  return sitting.status !== "open" || sitting.expires_at.getTime() <= now.getTime();
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
 */
export async function refuseIfSittingOver(
  db: Db,
  attempt: AttemptRow,
  now: Date = new Date(),
): Promise<NextResponse | null> {
  const over = await attemptSittingIsOver(db, attempt, now);
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
): Promise<boolean> {
  if (!attempt.test_session_id) return false;
  const [sitting] = await db
    .select({
      status: test_sessions.status,
      expires_at: test_sessions.expires_at,
    })
    .from(test_sessions)
    .where(eq(test_sessions.id, attempt.test_session_id))
    .limit(1);
  // A missing row cannot happen (the FK is SET NULL on delete), but a sitting
  // that is somehow unreadable is not grounds for discarding a student's work.
  if (!sitting) return false;
  return sittingIsOver(sitting, now);
}
