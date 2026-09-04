import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { test_sessions } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

/**
 * Closes a sitting early. Idempotent: closing an already-closed sitting is a
 * 200, not a 409 — a teacher pressing the button twice, or two teachers on one
 * class, should not see an error for reaching the state they wanted.
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
    return NextResponse.json({ test_session: row });
  }

  const [closed] = await db
    .update(test_sessions)
    .set({ status: "closed", updated_at: new Date() })
    .where(eq(test_sessions.id, row.id))
    .returning();
  return NextResponse.json({ test_session: closed });
}
