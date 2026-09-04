import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { peek_requests } from "@/db/schema";
import { requireStudent } from "@/lib/api/requireSession";
import { loadOwnAttempt } from "@/lib/api/studentAttempt";
import {
  PEEK_MAX_IMAGE_BASE64_LENGTH,
  PEEK_PENDING_TTL_MS,
} from "@/lib/api/peek";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

const Body = z.object({
  peek_id: z.string().regex(UUID_RE, "peek_id must be a uuid"),
  /** JPEG, base64. The client downscales; the cap is a backstop, not a budget. */
  image_base64: z.string().min(1).max(PEEK_MAX_IMAGE_BASE64_LENGTH),
});

/**
 * On-demand peek, the student's answer to a pending request
 * (docs/on-demand-peek-design.md).
 *
 * Own-attempt only, and only against a request that is still open and still
 * fresh: one that was replaced, delivered, or has aged past
 * PEEK_PENDING_TTL_MS answers 404 — the client's upload is fire-and-forget
 * and a stale frame must never become deliverable after the teacher was
 * already told "unavailable".
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;

  const [delivered] = await db
    .update(peek_requests)
    .set({ delivered_at: new Date(), image_base64: body.image_base64 })
    .where(
      and(
        eq(peek_requests.id, body.peek_id),
        eq(peek_requests.attempt_id, access.attempt.id),
        isNull(peek_requests.delivered_at),
        gt(
          peek_requests.requested_at,
          new Date(Date.now() - PEEK_PENDING_TTL_MS),
        ),
      ),
    )
    .returning({ id: peek_requests.id });

  if (!delivered) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}
