import { NextResponse } from "next/server";
import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attempts, test_sessions } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

/**
 * Closes a sitting early. Idempotent: closing an already-closed sitting is a
 * 200, not a 409 — a teacher pressing the button twice, or two teachers on one
 * class, should not see an error for reaching the state they wanted.
 *
 * D-1/D-6 (docs/close-session-ends-attempts-design.md): the sitting is all
 * that closes. Every attempt bound to it stays `in_progress` and resumable
 * through a later sitting; the student-plane routes refuse its writes from
 * this moment (`lib/api/sittingOver.ts`) and the client returns the student to
 * Your tests. Nothing here writes an attempt status and nothing writes an
 * event — the client reports its own `sitting_closed` row.
 *
 * `in_progress` rides along so the teacher's confirm dialog can say how many
 * students it just sent home. Counted AFTER the close (or on the already-closed
 * path) so the number reflects what the teacher is looking at; the dialog reads
 * its own count from the attendance rows before confirming.
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { sessionId } = await ctx.params;
  if (!UUID_RE.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(test_sessions)
    .where(
      and(
        eq(test_sessions.id, sessionId),
        eq(test_sessions.owner_sub, auth.session.sub),
      ),
    )
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (row.status === "closed") {
    return NextResponse.json({
      test_session: row,
      in_progress: await countStillWorking(db, row.id),
    });
  }

  const [closed] = await db
    .update(test_sessions)
    .set({ status: "closed", updated_at: new Date() })
    .where(eq(test_sessions.id, row.id))
    .returning();
  return NextResponse.json({
    test_session: closed,
    in_progress: await countStillWorking(db, row.id),
  });
}

/** Attempts still `in_progress` on this sitting — D-6's count. */
async function countStillWorking(
  db: ReturnType<typeof getDb>,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(attempts)
    .where(
      and(
        eq(attempts.test_session_id, sessionId),
        eq(attempts.status, "in_progress"),
      ),
    );
  return Number(row?.n ?? 0);
}
