import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { sessionOpenResponse, sittingIsOpen } from "@/lib/api/staffAttempt";
import { authorizeAttempt } from "@/lib/api/access";
import { isPastDeadline, loadDeadline } from "@/lib/api/attemptDeadline";
import { handInAttempt } from "@/lib/api/handInAttempt";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * Hand an attempt in on the student's behalf
 * (docs/time-limit-and-unfinished-attempts-design.md, D-1/A).
 *
 * The gap this closes: the client ends the secure session when the time limit
 * runs out and deliberately does NOT submit (D-2), so the attempt stays in
 * progress — and every teacher results surface was submitted-only. Without
 * this route a student who ran out of time has work that is saved, visible in
 * nothing, and scoreable by no one.
 *
 * Owner-only, like Delete: a colleague the assessment is shared with may score
 * a response but may not decide that someone's test is over.
 *
 * Two refusals, both 409:
 *   - `already_submitted` — the attempt is not in progress. Not idempotent-
 *     silent like the student's own submit, because a teacher pressing this is
 *     making a decision and deserves to hear that it was already made (and by
 *     whom, on the page that shows `submitted_by_sub`).
 *   - `session_open` — the sitting is still open, so the student may be locked
 *     in and mid-answer; handing in under them would freeze a half-written
 *     answer. RELAXED once the attempt's own deadline has passed: at that
 *     point the server is refusing their writes anyway (D-4), so there is no
 *     answer in flight to protect and making the teacher close the whole
 *     sitting first would be ceremony.
 *
 * On success the same auto-scoring pass the student's own submit runs fires
 * here — a forced hand-in produces a scored attempt, not a special case the
 * teacher has to remember to score by hand. A scoring failure must never fail
 * the hand-in (the pass is idempotent and re-runnable).
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAttempt(db, auth.session, attemptId, "run");
  if (!access.ok) return access.response;
  const attempt = access.attempt;

  if (attempt.status !== "in_progress") {
    return NextResponse.json(
      { ok: false, error: "already_submitted" },
      { status: 409 },
    );
  }

  const deadline = await loadDeadline(db, attempt);
  const timeIsUp = isPastDeadline(new Date(), deadline);
  if (!timeIsUp && (await sittingIsOpen(db, attempt))) {
    return sessionOpenResponse();
  }

  // The write itself lives in lib/api/handInAttempt.ts, shared with the
  // sitting-wide "Hand in everyone now" route.
  const { attempt: row, scored } = await handInAttempt(db, attempt, auth.session.sub);

  return NextResponse.json({ ok: true, attempt: row, scored });
}
