import { NextResponse } from "next/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { peek_requests } from "@/db/schema";
import { requireStudent } from "@/lib/api/requireSession";
import { loadOwnAttempt } from "@/lib/api/studentAttempt";
import { attemptSittingIsOver } from "@/lib/api/sittingOver";
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
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStudent();
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

  return NextResponse.json({
    ok: true,
    pending: pending ?? null,
    sitting: over ? "closed" : "open",
  });
}
