import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessment_shares } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { loadOwnedAssessment } from "@/lib/api/loadOwned";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; shareId: string }>;
}

// Slice C: the owner withdraws an offer. If the colleague already added
// their copy, that copy is theirs and stays; only the offer row goes.
export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, shareId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(shareId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedAssessment(id, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  const db = getDb();
  const deleted = await db
    .delete(assessment_shares)
    .where(and(eq(assessment_shares.id, shareId), eq(assessment_shares.assessment_id, id)))
    .returning({ id: assessment_shares.id });
  if (deleted.length === 0) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
