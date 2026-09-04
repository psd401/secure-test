import { NextResponse } from "next/server";
import { aiScoreResponse } from "@/lib/scoring/aiScoreResponse";
import { loadResponseChain } from "@/lib/api/reviewActions";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ responseId: string }>;
}

// Slice 39: explicit per-response "re-run AI" — unlike the attempt-wide
// score-ai route, this deliberately adds another proposed row even when a
// previous proposal exists (the queue shows the latest). Still refuses
// once a final exists: re-scoring settled work is an unsettle-first
// decision, not a button.
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { responseId } = await ctx.params;
  if (!UUID_RE.test(responseId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
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

  const outcome = await aiScoreResponse({
    item: chain.item,
    response: chain.response,
    ownerSub: auth.session.sub,
  });

  switch (outcome.kind) {
    case "scored":
      return NextResponse.json({ ok: true, status: outcome.status }, { status: 201 });
    case "not_ai":
      return NextResponse.json(
        { ok: false, error: "item_not_ai_scorable" },
        { status: 400 },
      );
    case "unscorable":
      return NextResponse.json(
        { ok: false, error: "response_unscorable" },
        { status: 400 },
      );
    case "blocked":
      return NextResponse.json(
        { ok: false, error: "blocked_by_guardrail" },
        { status: 422 },
      );
    case "provider_error":
      return NextResponse.json(
        { ok: false, error: "provider_error" },
        { status: 502 },
      );
    case "already_final":
      // Lost a race to a concurrent final (the route's own 409 pre-check
      // passed before the other request finalized).
      return NextResponse.json(
        { ok: false, error: "final_exists" },
        { status: 409 },
      );
  }
}
