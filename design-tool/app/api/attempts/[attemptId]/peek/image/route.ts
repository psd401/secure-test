import { NextResponse } from "next/server";
import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, attempts, peek_requests } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  PEEK_IMAGE_TTL_MS,
  PEEK_PENDING_TTL_MS,
  sweepExpiredPeekImages,
} from "@/lib/api/peek";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * On-demand peek, the teacher's collect (docs/on-demand-peek-design.md).
 *
 * Owner-only. Not ready yet reads as a status ("pending" while a live
 * request is out, "none" otherwise) so the monitor can poll this one
 * endpoint; ready hands over the image and DELETES it (viewed_at stamped,
 * image nulled — decision 6.4's delete-on-read). Two concurrent readers are
 * settled by the conditional UPDATE: the one that flips viewed_at from null
 * returns the bytes, the other falls through to the status answer.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select({ ownerSub: assessments.owner_sub })
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

  await sweepExpiredPeekImages(db);

  const [ready] = await db
    .select({
      id: peek_requests.id,
      image_base64: peek_requests.image_base64,
      delivered_at: peek_requests.delivered_at,
      requested_at: peek_requests.requested_at,
    })
    .from(peek_requests)
    .where(
      and(
        eq(peek_requests.attempt_id, attemptId),
        isNotNull(peek_requests.delivered_at),
        isNull(peek_requests.viewed_at),
        isNotNull(peek_requests.image_base64),
        gt(
          peek_requests.delivered_at,
          new Date(Date.now() - PEEK_IMAGE_TTL_MS),
        ),
      ),
    )
    .orderBy(desc(peek_requests.delivered_at))
    .limit(1);

  if (ready) {
    const [won] = await db
      .update(peek_requests)
      .set({ viewed_at: new Date(), image_base64: null })
      .where(and(eq(peek_requests.id, ready.id), isNull(peek_requests.viewed_at)))
      .returning({ id: peek_requests.id });
    if (won) {
      return NextResponse.json({
        ok: true,
        status: "ready",
        image_base64: ready.image_base64,
        requested_at: ready.requested_at,
        delivered_at: ready.delivered_at,
      });
    }
  }

  const [pending] = await db
    .select({ id: peek_requests.id })
    .from(peek_requests)
    .where(
      and(
        eq(peek_requests.attempt_id, attemptId),
        isNull(peek_requests.delivered_at),
        gt(
          peek_requests.requested_at,
          new Date(Date.now() - PEEK_PENDING_TTL_MS),
        ),
      ),
    )
    .limit(1);

  return NextResponse.json({
    ok: true,
    status: pending ? "pending" : "none",
  });
}
