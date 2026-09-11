import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { assessments, attempts, test_sessions, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export type OwnedAttempt =
  | { ok: true; attempt: AttemptRow }
  | { ok: false; response: NextResponse };

/**
 * Load an attempt and prove the caller OWNS the assessment it belongs to.
 *
 * Owner-only, not shared-staff (D-R5): a colleague the assessment is shared
 * with may score a response, but forcing a submission or erasing a record is
 * the owner's alone.
 *
 * Extracted from `DELETE /api/attempts/[attemptId]` when the hand-in route
 * (docs/time-limit-and-unfinished-attempts-design.md) needed the identical
 * checks — two copies of an authorisation rule is one copy too many, and the
 * statuses (404 unknown, 403 someone else's) have to match or a caller can
 * tell the two apart.
 */
export async function loadOwnedAttempt(
  db: Db,
  attemptId: string,
  ownerSub: string,
): Promise<OwnedAttempt> {
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .limit(1);
  if (!attempt) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }),
    };
  }
  const [assessment] = await db
    .select({ owner_sub: assessments.owner_sub })
    .from(assessments)
    .where(eq(assessments.id, attempt.assessment_id))
    .limit(1);
  if (!assessment || assessment.owner_sub !== ownerSub) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, attempt };
}

/**
 * Is this attempt still live in an open sitting — i.e. might the student be
 * locked in and mid-answer right now?
 *
 * The one rule behind both destructive teacher actions: deleting the attempt
 * would 404 the student's next save under them, and handing it in would turn
 * a half-written answer into a final one.
 *
 * Note what is NOT part of it: the sitting's `expires_at`. `attemptAcceptsWrites`
 * (lib/api/studentAttempt.ts) deliberately keeps taking answers after a sitting
 * expires — "a sitting that expires while a child is mid-sentence should not
 * discard the sentence" — so a student can still be writing in an open sitting
 * that is past its expiry, and the guard has to hold there too. A submitted
 * attempt is never blocked: there is no answer in flight to protect.
 */
export async function sittingIsOpen(db: Db, attempt: AttemptRow): Promise<boolean> {
  if (attempt.status === "submitted") return false;
  if (!attempt.test_session_id) return false;
  const [sitting] = await db
    .select({ status: test_sessions.status })
    .from(test_sessions)
    .where(eq(test_sessions.id, attempt.test_session_id))
    .limit(1);
  return sitting?.status === "open";
}

export function sessionOpenResponse(): NextResponse {
  return NextResponse.json({ ok: false, error: "session_open" }, { status: 409 });
}
