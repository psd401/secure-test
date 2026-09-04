import { NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, attempts, peek_requests } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  PEEK_RATE_LIMIT_MS,
  sweepExpiredPeekImages,
} from "@/lib/api/peek";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * On-demand peek, the teacher's ask (docs/on-demand-peek-design.md).
 *
 * Owner-only, like the monitor it is launched from; only an in-progress
 * attempt has a screen worth looking at (6.2 allows it locked or unlocked,
 * but not submitted). Rate-limited per attempt (6.5), and a re-request
 * replaces any pending one — at most one open question to the client at a
 * time.
 *
 * The peek surface is four single-role routes on purpose — this one and
 * `peek/image` (GET) are staff; `peek/pending` and `peek/upload` are the
 * student's — so the slice-58 role sweep can classify each file whole.
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select({ attempt: attempts, ownerSub: assessments.owner_sub })
    .from(attempts)
    .innerJoin(assessments, eq(attempts.assessment_id, assessments.id))
    .where(eq(attempts.id, attemptId))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (row.ownerSub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (row.attempt.status !== "in_progress") {
    return NextResponse.json(
      { ok: false, error: "attempt_not_in_progress" },
      { status: 409 },
    );
  }

  await sweepExpiredPeekImages(db);

  const [recent] = await db
    .select({ id: peek_requests.id })
    .from(peek_requests)
    .where(
      and(
        eq(peek_requests.attempt_id, attemptId),
        gt(peek_requests.requested_at, new Date(Date.now() - PEEK_RATE_LIMIT_MS)),
      ),
    )
    .limit(1);
  if (recent) {
    return NextResponse.json({ ok: false, error: "too_soon" }, { status: 429 });
  }

  // Replace, don't stack: an undelivered older request would race this one
  // at the client. Delivered rows stay — they are audit.
  await db
    .delete(peek_requests)
    .where(
      and(
        eq(peek_requests.attempt_id, attemptId),
        isNull(peek_requests.delivered_at),
      ),
    );

  const [peek] = await db
    .insert(peek_requests)
    .values({ attempt_id: attemptId, requested_by: auth.session.sub })
    .returning();

  return NextResponse.json(
    { ok: true, peek: { id: peek!.id, requested_at: peek!.requested_at } },
    { status: 201 },
  );
}
