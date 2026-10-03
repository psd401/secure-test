import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, attempts } from "@/db/schema";
import { requireStudentOrPractice } from "@/lib/api/requireSession";
import { loadOwnAttempt } from "@/lib/api/studentAttempt";
import { refuseIfPastDeadline } from "@/lib/api/attemptDeadline";
import { refuseIfSittingOver } from "@/lib/api/sittingOver";
import { runAutoScoringPass } from "@/lib/scoring/runAutoScoring";
import { scheduleAttemptScreening } from "@/lib/safeguarding/screening/screen";
import {
  feedbackForAttempt,
  feedbackWasShown,
  recordFeedbackShown,
} from "@/lib/feedback/attemptFeedback";
import type { Feedback, FeedbackSettings } from "@/lib/feedback/buildFeedback";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * Hand the attempt in. Idempotent — submitting twice returns the attempt as it
 * stands rather than an error, because a flaky network retrying the request is
 * indistinguishable from a student pressing the button twice, and neither
 * deserves a failure.
 *
 * `submitted_at` is set only on the transition, so a retry cannot quietly move
 * the timestamp a teacher may be reading as "when did they finish".
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStudentOrPractice();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;

  if (access.attempt.status === "submitted") {
    // Instant feedback: a retry of a hand-in that WAS shown feedback (the
    // event exists, so the first response was built) gets it again — the
    // first answer may have been lost on the wire. No second event. A
    // teacher's hand-in never wrote one, so D-6 holds on this path too.
    let feedback: Feedback | null = null;
    if (access.attempt.pass_back_count === 0 && (await feedbackWasShown(db, access.attempt.id))) {
      try {
        feedback = await feedbackForAttempt(
          db,
          access.attempt,
          await feedbackSettings(db, access.attempt.assessment_id),
        );
      } catch (err) {
        console.error("submit: feedback rebuild failed", err);
      }
    }
    return NextResponse.json({
      attempt: access.attempt,
      already_submitted: true,
      ...(feedback ? { feedback } : {}),
    });
  }

  // D-1..D-3 (docs/close-session-ends-attempts-design.md): a hand-in that
  // arrives after Close is refused for the same reason a late submit is — the
  // attempt stays in progress and resumable, and finalising it is the
  // teacher's hand-in route. Checked before the deadline so the client is told
  // which clock stopped it. No grace here (the write guards get 10 s for the
  // flush in flight; a hand-in is not a flush).
  const closed = await refuseIfSittingOver(db, access.attempt, new Date(), 0);
  if (closed) return closed;

  // D-4: handing in after the deadline is the TEACHER's call, not the
  // student's — the client ends the secure session at zero and deliberately
  // leaves the attempt in progress (D-2), so a late submit here would be a
  // client that ignored the clock. `POST /api/attempts/[attemptId]/hand-in`
  // is the door that stays open.
  const expired = await refuseIfPastDeadline(db, access.attempt);
  if (expired) return expired;

  const now = new Date();
  const [row] = await db
    .update(attempts)
    .set({ status: "submitted", submitted_at: now, updated_at: now })
    .where(eq(attempts.id, access.attempt.id))
    .returning();

  // Safeguarding alerts (docs/safeguarding-alerts-design.md, D-2): screen the
  // essay / short-text answers after the response is sent — never slows or
  // fails the hand-in.
  scheduleAttemptScreening(row!.id);

  // R0.1: auto-score in the same request the student hands in — same
  // idempotent pass the teacher-facing score route runs by hand. A scoring
  // failure must never fail the hand-in; log it and move on. Teachers can
  // still re-run scoring later (or immediately, since this is idempotent).
  try {
    await runAutoScoringPass(db, row!);
  } catch (err) {
    console.error("submit: auto-scoring failed", err);
  }

  // Instant feedback (docs/instant-feedback-design.md, D-2): built from the
  // finals the pass above just wrote. Only on the student's OWN hand-in —
  // teacher Hand in / Hand in everyone / time-out paths go through other
  // routes and never build it (D-6) — and never after a pass back (D-3).
  // Like scoring, a failure here must never fail the hand-in.
  let feedback: Feedback | null = null;
  if (row!.pass_back_count === 0) {
    try {
      const settings = await feedbackSettings(db, row!.assessment_id);
      feedback = await feedbackForAttempt(db, row!, settings);
      if (feedback) await recordFeedbackShown(db, row!.id, feedback, settings);
    } catch (err) {
      console.error("submit: instant feedback failed", err);
      feedback = null;
    }
  }

  return NextResponse.json({
    attempt: row,
    already_submitted: false,
    ...(feedback ? { feedback } : {}),
  });
}

async function feedbackSettings(
  db: ReturnType<typeof getDb>,
  assessmentId: string,
): Promise<FeedbackSettings> {
  const [settings] = await db
    .select({
      student_feedback: assessments.student_feedback,
      answers_release: assessments.answers_release,
      answers_released_at: assessments.answers_released_at,
    })
    .from(assessments)
    .where(eq(assessments.id, assessmentId))
    .limit(1);
  return (
    settings ?? { student_feedback: "off", answers_release: "on_release", answers_released_at: null }
  );
}
