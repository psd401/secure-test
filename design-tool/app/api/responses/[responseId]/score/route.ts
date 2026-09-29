import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { scores } from "@/db/schema";
import {
  ManualScoreBody,
  checkManualScore,
  loadResponseChain,
} from "@/lib/api/reviewActions";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ responseId: string }>;
}

// Slice 39: a teacher scores one response by hand. This is both the
// "score manually" action for human-method items AND the override path
// for AI proposals — a human final simply lands next to the retained
// proposed row (append-only audit; the one-final index keeps it unique).
// When the item has a rubric and the body carries criterion_scores, the
// picks are validated against the rubric exactly like AI output; bare
// points are accepted as a holistic override.
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { responseId } = await ctx.params;
  if (!UUID_RE.test(responseId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: ManualScoreBody;
  try {
    body = ManualScoreBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: String(err) },
      { status: 400 },
    );
  }

  const chain = await loadResponseChain(responseId, auth.session);
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

  const check = checkManualScore(chain.item, body);
  if (!check.ok) {
    return NextResponse.json(check.body, { status: check.status });
  }

  const db = getDb();
  // Review fix (2026-08-14): onConflictDoNothing closes the race between
  // the hasFinal check above and this insert — a concurrent final would
  // otherwise 500 on the one-final-per-response partial unique index.
  const [created] = await db
    .insert(scores)
    .values({
      response_id: chain.response.id,
      method: "human",
      points: body.points,
      max_points: body.max_points,
      rationale: {
        ...(body.criterion_scores
          ? { criterion_scores: body.criterion_scores }
          : {}),
        ...(body.note ? { note: body.note } : {}),
      },
      scorer: auth.session.sub,
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
