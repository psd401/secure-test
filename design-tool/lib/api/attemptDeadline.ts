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

/**
 * Working-time clock (docs/working-time-clock-design.md, Q4): the longest gap
 * between two clock ticks inside one session that still counts as working
 * time. Longer gaps are not counted and are logged as `clock_gap`.
 */
export const CLOCK_GAP_CAP_SECONDS = 120;

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
  /**
   * Working-time clock (docs/working-time-clock-design.md): seconds counted
   * so far, the instant they were counted to, and the extra seconds a teacher
   * granted. Required, like the two above, so a narrow select cannot drop
   * them and quietly fall back to the wrong clock.
   */
  working_seconds: number;
  last_tick_at: Date | null;
  extension_seconds: number;
}

export interface DeadlineAssessment {
  time_limit_seconds: number | null;
  /** `working` | `wall` (D1). Required for the same reason. */
  time_limit_mode: string;
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
  now: Date = new Date(),
): Date | null {
  if (attempt.time_limit_removed) return null;
  const limit = assessment.time_limit_seconds;
  if (limit != null && limit > 0 && assessment.time_limit_mode === "working") {
    return workingDeadline(attempt, limit, now);
  }
  if (attempt.deadline_override_at) return attempt.deadline_override_at;
  if (limit == null || limit <= 0) return null;
  return new Date(attempt.started_at.getTime() + limit * 1000);
}

/**
 * Working-time clock (docs/working-time-clock-design.md): the deadline is
 * `now + time left`, where time left = limit + extension − time spent.
 *
 * Time spent includes the stretch since the last tick when the attempt is
 * live (that tick is within the gap cap), so the deadline holds steady during
 * a session instead of drifting by up to one poll interval. Between sessions
 * the clock is paused, so the deadline moves later with `now` — the point of
 * the feature. Once time is used up:
 *   - live: `now + time left` is already in the past and moves further past
 *     as the student keeps going, so the shared 30 s grace still applies to
 *     the autosave in flight at the buzzer;
 *   - not live: a fixed "certainly past" instant, so a student whose time ran
 *     out cannot rejoin through the grace.
 * `deadline_override_at` is not read: a working-time test extends with
 * `extension_seconds` (D3).
 */
function workingDeadline(attempt: DeadlineAttempt, limit: number, now: Date): Date {
  const sinceTick = attempt.last_tick_at ? now.getTime() - attempt.last_tick_at.getTime() : null;
  const live = sinceTick !== null && sinceTick >= 0 && sinceTick <= CLOCK_GAP_CAP_SECONDS * 1000;
  const spent = attempt.working_seconds + (live ? sinceTick! / 1000 : 0);
  const left = limit + attempt.extension_seconds - spent;
  if (left > 0 || live) return new Date(now.getTime() + left * 1000);
  return new Date(now.getTime() - (DEADLINE_GRACE_SECONDS + 1) * 1000);
}

/**
 * Working-time clock, slice 1 compatibility: the Extend time and pass-back
 * dialogs still send an end time ("until 10:45"). On a working-time test that
 * becomes the `extension_seconds` that makes the clock end then if the
 * student works from `now` without a break:
 *   now + (limit + ext − spent) = endsAt  ⇒  ext = (endsAt − now) − limit + spent.
 * Rounded up to whole seconds. An end time earlier than the current one
 * shortens the time, as it does on the wall clock.
 */
export function extensionForEndTime(
  attempt: DeadlineAttempt,
  assessment: DeadlineAssessment,
  endsAt: Date,
  now: Date = new Date(),
): number {
  const limit = assessment.time_limit_seconds ?? 0;
  const sinceTick = attempt.last_tick_at ? now.getTime() - attempt.last_tick_at.getTime() : null;
  const live = sinceTick !== null && sinceTick >= 0 && sinceTick <= CLOCK_GAP_CAP_SECONDS * 1000;
  const spent = attempt.working_seconds + (live ? sinceTick! / 1000 : 0);
  return Math.ceil((endsAt.getTime() - now.getTime()) / 1000 - limit + spent);
}

/** Working-time clock: is this assessment's limit counted as working time? */
export function isWorkingTimeLimit(assessment: DeadlineAssessment): boolean {
  return (assessment.time_limit_seconds ?? 0) > 0 && assessment.time_limit_mode === "working";
}

/**
 * Working-time clock: seconds of the limit left, for the Monitor (D5) — null
 * when this attempt is not on a working-time limit.
 */
export function workingTimeLeft(
  attempt: DeadlineAttempt,
  assessment: DeadlineAssessment,
  now: Date = new Date(),
): { used: number; left: number } | null {
  if (attempt.time_limit_removed) return null;
  const limit = assessment.time_limit_seconds;
  if (limit == null || limit <= 0 || assessment.time_limit_mode !== "working") return null;
  const sinceTick = attempt.last_tick_at ? now.getTime() - attempt.last_tick_at.getTime() : null;
  const live = sinceTick !== null && sinceTick >= 0 && sinceTick <= CLOCK_GAP_CAP_SECONDS * 1000;
  const used = attempt.working_seconds + (live ? sinceTick! / 1000 : 0);
  return { used, left: Math.max(0, limit + attempt.extension_seconds - used) };
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

/** The time-limit fields of this attempt's assessment, or null if it is gone. */
export async function loadTimeLimit(
  db: Pick<Db, "select">,
  attempt: Pick<AttemptRow, "assessment_id">,
): Promise<DeadlineAssessment | null> {
  const [assessment] = await db
    .select({
      time_limit_seconds: assessments.time_limit_seconds,
      time_limit_mode: assessments.time_limit_mode,
    })
    .from(assessments)
    .where(eq(assessments.id, attempt.assessment_id))
    .limit(1);
  return assessment ?? null;
}

/** This attempt's deadline, read from its own assessment. Null = no limit. */
export async function loadDeadline(
  db: Db,
  attempt: AttemptRow,
  now: Date = new Date(),
): Promise<Date | null> {
  const assessment = await loadTimeLimit(db, attempt);
  if (!assessment) return null;
  return deadlineFor(attempt, assessment, now);
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
  opts: { join?: boolean } = {},
): Promise<NextResponse | null> {
  // Working-time clock: a join never counts the time since the last tick
  // (`tickWorkingClock`, `join`), so its refusal must not count it either —
  // judged as not live, on the stored total alone. A relaunch with 5 s left
  // gets in; one with nothing left is refused (the fixed past instant). The
  // wall clock never reads `last_tick_at`, so this changes nothing there.
  const judged = opts.join ? { ...attempt, last_tick_at: null } : attempt;
  const deadline = await loadDeadline(db, judged, now);
  if (!isPastDeadline(now, deadline)) return null;
  return NextResponse.json({ ok: false, error: "time_expired" }, { status: 409 });
}
