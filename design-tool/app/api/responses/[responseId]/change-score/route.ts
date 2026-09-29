import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { changeFinalScore } from "@/lib/api/changeScore";
import {
  ChangeScoreBody,
  checkManualScore,
  loadResponseChain,
} from "@/lib/api/reviewActions";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ responseId: string }>;
}

// Change a final score (docs/change-score-design.md, D-1): supersede the
// response's current `final` and write a new human final beside it. The same
// access and the same body rules as the score route (edit level, 404 posture,
// max_points = the item's max, criterion picks against the scoring view) —
// the difference is the precondition: this route REQUIRES a final, and answers
// 409 `no_final` without one (the score route is the path then). A
// passed-back attempt is in progress, so it is refused by the shared chain
// (`attempt_not_submitted`) before either route looks at its scores.
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { responseId } = await ctx.params;
  if (!UUID_RE.test(responseId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: ChangeScoreBody;
  try {
    body = ChangeScoreBody.parse(await req.json());
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
  if (!chain.hasFinal) {
    return NextResponse.json({ ok: false, error: "no_final" }, { status: 409 });
  }

  const check = checkManualScore(chain.item, body);
  if (!check.ok) {
    return NextResponse.json(check.body, { status: check.status });
  }

  const result = await changeFinalScore(
    getDb(),
    {
      response_id: chain.response.id,
      attempt_id: chain.response.attempt_id,
      item_id: chain.response.item_id,
    },
    body,
    auth.session.sub,
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 409 });
  }

  return NextResponse.json({ ok: true, score: result.score }, { status: 201 });
}
