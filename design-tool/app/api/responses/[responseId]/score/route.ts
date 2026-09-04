import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { scores } from "@/db/schema";
import {
  rubricMaxPoints,
  validateAgainstRubric,
} from "@/lib/ai/essayScorer/scoreCore";
import { ManualScoreBody, loadResponseChain } from "@/lib/api/reviewActions";
import { requireStaff } from "@/lib/api/requireSession";
import { tableMaxPoints } from "@/lib/scoring/auto";
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

  const chain = await loadResponseChain(responseId, auth.session.sub);
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

  const rubric = chain.item.config.rubric;
  // Review fix (2026-08-14, finding 4): max_points is not caller-chosen —
  // it must equal the rubric max when a rubric exists, else 1 (the
  // slice-37 every-item-worth-1-point rule). Otherwise the same column
  // carries different maxima per student and results/CSV totals become
  // incomparable. E3 slice 2: a table is worth its cells (keyed cells when
  // any, else every cell) — a per-item constant, so the rule still holds.
  const expectedMax = rubric
    ? rubricMaxPoints(rubric)
    : chain.item.type === "table"
      ? tableMaxPoints(chain.item.config)
      : 1;
  if (body.max_points !== expectedMax) {
    return NextResponse.json(
      {
        ok: false,
        error: "max_points_mismatch",
        expected: expectedMax,
      },
      { status: 400 },
    );
  }
  if (body.criterion_scores) {
    if (!rubric) {
      return NextResponse.json(
        { ok: false, error: "item_has_no_rubric" },
        { status: 400 },
      );
    }
    const bounds = validateAgainstRubric(
      {
        criterion_scores: body.criterion_scores,
        points: body.points,
        max_points: body.max_points,
      },
      rubric,
    );
    if (!bounds.valid) {
      return NextResponse.json(
        { ok: false, error: "rubric_bounds", detail: bounds.reason },
        { status: 400 },
      );
    }
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
