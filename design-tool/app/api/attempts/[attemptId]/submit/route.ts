import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attempts } from "@/db/schema";
import { requireStudent } from "@/lib/api/requireSession";
import { loadOwnAttempt } from "@/lib/api/studentAttempt";
import { runAutoScoringPass } from "@/lib/scoring/runAutoScoring";
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
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;

  if (access.attempt.status === "submitted") {
    return NextResponse.json({ attempt: access.attempt, already_submitted: true });
  }

  const now = new Date();
  const [row] = await db
    .update(attempts)
    .set({ status: "submitted", submitted_at: now, updated_at: now })
    .where(eq(attempts.id, access.attempt.id))
    .returning();

  // R0.1: auto-score in the same request the student hands in — same
  // idempotent pass the teacher-facing score route runs by hand. A scoring
  // failure must never fail the hand-in; log it and move on. Teachers can
  // still re-run scoring later (or immediately, since this is idempotent).
  try {
    await runAutoScoringPass(db, row!);
  } catch (err) {
    console.error("submit: auto-scoring failed", err);
  }

  return NextResponse.json({ attempt: row, already_submitted: false });
}
