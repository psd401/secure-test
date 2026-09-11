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
 * The deadline is per ATTEMPT — `started_at + time_limit_seconds` — not per
 * sitting. A student who relaunches, or who resumes through a second sitting,
 * keeps the deadline their attempt began with; the sitting's `expires_at` is
 * a separate clock governing who may START.
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
}

export interface DeadlineAssessment {
  time_limit_seconds: number | null;
}

/**
 * The instant this attempt's time runs out, or null when the assessment has
 * no limit (the overwhelming majority — everything about this feature has to
 * leave those untouched).
 *
 * A non-positive limit is treated as no limit rather than as "already over":
 * a 0 stored by a form that wrote an empty field as a number should not lock
 * a class out of a test.
 */
export function deadlineFor(
  attempt: DeadlineAttempt,
  assessment: DeadlineAssessment,
): Date | null {
  const limit = assessment.time_limit_seconds;
  if (limit == null || limit <= 0) return null;
  return new Date(attempt.started_at.getTime() + limit * 1000);
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
