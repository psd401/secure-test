/**
 * Time limit (docs/time-limit-and-unfinished-attempts-design.md, D-4).
 *
 * One place decides when an attempt's time is up, because four callers need
 * the same answer and a limit that holds on three of them is not a limit:
 * the delivery bundle (what the client counts down to), the response write,
 * the drawing-slot completion, and the student's own submit. The teacher's
 * hand-in route asks the same question for the opposite reason — once time
 * has passed, the "the student may be mid-answer" refusal stops applying.
 *
 * `assessments.time_limit_seconds` has been authored on the Settings tab for
 * a long time and read by nothing; this is the file that starts reading it.
 *
 * The deadline is per ATTEMPT — `started_at + time_limit_seconds`, or the
 * teacher's `deadline_override_at` when one was granted — not per sitting. A
 * student who relaunches, or who resumes through a second sitting, keeps the
 * deadline their attempt began with (and keeps any extension, which is why the
 * override lives on the attempt); the sitting's `expires_at` is a separate
 * clock governing who may START.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { assessments, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

/** The grace after the deadline in which a write is still accepted. */
export const DEADLINE_GRACE_SECONDS = 30;

export interface DeadlineAttempt {
  started_at: Date;
  /**
   * The teacher's extension, if one was granted (`POST …/extend`). REQUIRED on
   * this interface rather than optional, deliberately: every consumer of
   * `deadlineFor` narrows an attempt row to its own select list, and an
   * optional field would let one of them quietly keep enforcing the old
   * deadline against a student the teacher had already given more time. Making
   * it required means the typechecker names the callers that need the column.
   */
  deadline_override_at: Date | null;
  /**
   * The teacher's "No time limit" (2026-09-24). Required for the same reason
   * as `deadline_override_at`: a consumer that forgot to select it would keep
   * counting a student down whose limit the teacher had removed.
   */
  time_limit_removed: boolean;
}

export interface DeadlineAssessment {
  time_limit_seconds: number | null;
}

/**
 * The instant this attempt's time runs out, or null when there is no limit at
 * all (the overwhelming majority — everything about this feature has to leave
 * those untouched).
 *
 * The override WINS, and it wins regardless of the assessment's own limit:
 *   - a limited assessment with an override counts down to the override, not
 *     to `started_at + limit`, whether the override is later or earlier;
 *   - an UNLIMITED assessment with an override gains a deadline it did not
 *     have. That is intentional and is what a teacher saying "you have until
 *     10:45" to one student means; it is also the only shape that lets the
 *     extension be an absolute instant rather than arithmetic on a limit that
 *     may not exist.
 *
 * A REMOVED limit beats both: the teacher's "No time limit" returns null
 * before the override or the assessment's limit is read.
 *
 * A non-positive limit is treated as no limit rather than as "already over":
 * a 0 stored by a form that wrote an empty field as a number should not lock
 * a class out of a test.
 */
export function deadlineFor(
  attempt: DeadlineAttempt,
  assessment: DeadlineAssessment,
): Date | null {
  if (attempt.time_limit_removed) return null;
  if (attempt.deadline_override_at) return attempt.deadline_override_at;
  const limit = assessment.time_limit_seconds;
  if (limit == null || limit <= 0) return null;
  return new Date(attempt.started_at.getTime() + limit * 1000);
}

/**
 * Pass back (docs/pass-back-design.md): does this attempt have a deadline AT
 * ALL — a limit on the assessment or an override on the attempt — whatever
 * its status and whenever it falls. The pass-back route asks it to decide
 * whether a new deadline is required; the Monitor and the per-student page
 * ask it so the dialog knows up front. One rule in one place since the
 * removed limit (2026-09-24) added a third term: a removed attempt is NOT
 * timed, so a pass back neither asks for a deadline nor gives it one, and the
 * attempt stays removed.
 */
export function attemptIsTimed(
  attempt: Pick<DeadlineAttempt, "deadline_override_at" | "time_limit_removed">,
  assessment: DeadlineAssessment,
): boolean {
  if (attempt.time_limit_removed) return false;
  return (assessment.time_limit_seconds ?? 0) > 0 || attempt.deadline_override_at !== null;
}

/**
 * Is `now` past the deadline plus its grace?
 *
 * The grace (30 s, D-4) exists for the autosave that was already in flight
 * when the buzzer went: refusing it would discard an answer the student had
 * finished writing, which is the one outcome a time limit must not produce.
 * A null deadline is never past — no limit, nothing to enforce.
 */
export function isPastDeadline(
  now: Date,
  deadline: Date | null,
  graceSeconds: number = DEADLINE_GRACE_SECONDS,
): boolean {
  if (!deadline) return false;
  return now.getTime() > deadline.getTime() + graceSeconds * 1000;
}

/** This attempt's deadline, read from its own assessment. Null = no limit. */
export async function loadDeadline(
  db: Db,
  attempt: AttemptRow,
): Promise<Date | null> {
  const [assessment] = await db
    .select({ time_limit_seconds: assessments.time_limit_seconds })
    .from(assessments)
    .where(eq(assessments.id, attempt.assessment_id))
    .limit(1);
  if (!assessment) return null;
  return deadlineFor(attempt, assessment);
}

/**
 * The student-plane guard: the 409 body when this attempt's time is up, or
 * null when the write may proceed.
 *
 * Returned rather than thrown so each route keeps its own ordering of checks
 * visible — this one belongs after the attempt is loaded and proven to be the
 * caller's, and before anything is written.
 */
export async function refuseIfPastDeadline(
  db: Db,
  attempt: AttemptRow,
  now: Date = new Date(),
): Promise<NextResponse | null> {
  const deadline = await loadDeadline(db, attempt);
  if (!isPastDeadline(now, deadline)) return null;
  return NextResponse.json({ ok: false, error: "time_expired" }, { status: 409 });
}
