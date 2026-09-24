import { NextResponse } from "next/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { peek_requests } from "@/db/schema";
import { requireStudentOrPractice } from "@/lib/api/requireSession";
import { loadOwnAttempt } from "@/lib/api/studentAttempt";
import { attemptSittingIsOver } from "@/lib/api/sittingOver";
import { loadDeadline } from "@/lib/api/attemptDeadline";
import { PEEK_PENDING_TTL_MS, sweepExpiredPeekImages } from "@/lib/api/peek";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * On-demand peek, the student's poll: "does my teacher want a look?" — asked
 * every 5 s while an attempt is open (docs/on-demand-peek-design.md).
 *
 * Own-attempt only (the slice-91 pattern: someone else's attempt is a 404,
 * indistinguishable from absent). Only a request younger than
 * PEEK_PENDING_TTL_MS comes back: an app that was offline when the teacher
 * clicked must not render a surprise minutes later — the banner shows at
 * pickup, and pickup has a deadline.
 *
 * D-5 (docs/close-session-ends-attempts-design.md): this poll is also how a
 * working client learns its sitting was closed, hence `sitting`. Deliberately
 * no new channel and no new timer — a Close reaches the client within the 5 s
 * it already waits. An attempt with no sitting at all (the `--token` dev
 * posture, the seeder) reports "open": nothing governs it.
 *
 * EX-1 (2026-09-23): the poll also carries the attempt's deadline, in the
 * delivery bundle's own shape — `time_limit_ends_at` + `server_now`, both or
 * neither — so an Extend time (or a pass back's new deadline) reaches a
 * client that is already counting down. Before this the client read the
 * deadline only at join, and a teacher's change landed on the next join.
 *
 * No time limit (2026-09-24): a teacher's "No time limit" makes deadlineFor
 * return null, so the deadline pair drops out — but an absent pair already
 * means "no news" to the client (an untimed attempt, or a poll that says
 * nothing about time), and the countdown it started at join would keep
 * running and end the session at the old zero. So a removed attempt says so
 * explicitly: `time_limit_removed: true`, omitted otherwise like the pair.
 * The client (v1.3.5) stops its countdown and drops the strip on it.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStudentOrPractice();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;

  await sweepExpiredPeekImages(db);

  const [pending] = await db
    .select({ id: peek_requests.id, requested_at: peek_requests.requested_at })
    .from(peek_requests)
    .where(
      and(
        eq(peek_requests.attempt_id, access.attempt.id),
        isNull(peek_requests.delivered_at),
        gt(
          peek_requests.requested_at,
          new Date(Date.now() - PEEK_PENDING_TTL_MS),
        ),
      ),
    )
    .orderBy(desc(peek_requests.requested_at))
    .limit(1);

  const over = await attemptSittingIsOver(db, access.attempt);
  const deadline = await loadDeadline(db, access.attempt);

  return NextResponse.json({
    ok: true,
    pending: pending ?? null,
    sitting: over ? "closed" : "open",
    ...(deadline
      ? {
          time_limit_ends_at: deadline.toISOString(),
          server_now: new Date().toISOString(),
        }
      : {}),
    ...(access.attempt.time_limit_removed ? { time_limit_removed: true } : {}),
  });
}
