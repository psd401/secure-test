import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { scores } from "@/db/schema";
import { loadResponseChain } from "@/lib/api/reviewActions";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ scoreId: string }>;
}

// Slice 39: approve an AI-proposed score. Append-only: a NEW final row is
// inserted copying the proposal's numbers and rationale — method stays
// 'ai' and scorer stays the model id (the score is the model's work), but
// reviewed_by_sub records the human who approved it. The proposed row is
// retained as audit trail.
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { scoreId } = await ctx.params;
  if (!UUID_RE.test(scoreId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [proposal] = await db
    .select()
    .from(scores)
    .where(eq(scores.id, scoreId))
    .limit(1);
  if (!proposal) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (proposal.status !== "proposed") {
    return NextResponse.json(
      { ok: false, error: "not_a_proposal" },
      { status: 400 },
    );
  }

  const chain = await loadResponseChain(proposal.response_id, auth.session.sub);
  if (!chain.ok) {
    return NextResponse.json(
      { ok: false, error: chain.error },
      { status: chain.status },
    );
  }
  if (chain.hasFinal) {
    return NextResponse.json(
      { ok: false, error: "final_exists" },
      { status: 409 },
    );
  }

  // Review fix (2026-08-14): onConflictDoNothing closes the race between
  // the hasFinal check above and this insert (concurrent approve/score
  // would otherwise 500 on the one-final partial unique index).
  const [created] = await db
    .insert(scores)
    .values({
      response_id: proposal.response_id,
      method: "ai",
      points: proposal.points,
      max_points: proposal.max_points,
      rationale: proposal.rationale,
      scorer: proposal.scorer,
      status: "final",
      reviewed_by_sub: auth.session.sub,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    return NextResponse.json(
      { ok: false, error: "final_exists" },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, score: created }, { status: 201 });
}
