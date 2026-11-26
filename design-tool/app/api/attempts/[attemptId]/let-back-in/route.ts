import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAttempt } from "@/lib/api/access";
import { loadTimeLimit } from "@/lib/api/attemptDeadline";
import { approveRejoin } from "@/lib/api/rejoinApproval";
import { onWorkingClock } from "@/lib/api/workingClock";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * "Let back in" (docs/working-time-clock-design.md, D2, slice 3): the
 * teacher approves one student's return to a working-time test they left.
 * The approval lasts 10 minutes and is used up by the join it admits
 * (`lib/api/rejoinApproval.ts`).
 *
 * `run` + `write` through `authorizeAttempt`, like Adjust time: the person
 * running the session decides. Refusals:
 *   - 409 `not_in_progress` — handed in; there is nothing to come back to.
 *   - 409 `not_working_time` — the test is not on the working-time clock
 *     (wall clock, untimed, limit removed), so a rejoin never waits.
 * No body. Pressing it again renews the 10 minutes.
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAttempt(db, auth.session, attemptId, "run", "write");
  if (!access.ok) return access.response;
  const attempt = access.attempt;

  if (attempt.status !== "in_progress") {
    return NextResponse.json({ ok: false, error: "not_in_progress" }, { status: 409 });
  }
  const timeLimit = await loadTimeLimit(db, attempt);
  if (!timeLimit || !onWorkingClock(attempt, timeLimit)) {
    return NextResponse.json({ ok: false, error: "not_working_time" }, { status: 409 });
  }

  const row = await approveRejoin(db, attempt, auth.session.sub);
  return NextResponse.json({
    ok: true,
    attempt_id: row.id,
    rejoin_approved_until: row.rejoin_approved_until?.toISOString() ?? null,
  });
}
