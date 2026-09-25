import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { aiScoreResponse } from "@/lib/scoring/aiScoreResponse";
import { loadResponseChain } from "@/lib/api/reviewActions";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { injectionAlertFor, recordAiForced } from "@/lib/safeguarding/alerts";
import { screenResponse } from "@/lib/safeguarding/screening/screen";

interface RouteContext {
  params: Promise<{ responseId: string }>;
}

// Slice 39: explicit per-response "re-run AI" — unlike the attempt-wide
// score-ai route, this deliberately adds another proposed row even when a
// previous proposal exists (the queue shows the latest). Still refuses
// once a final exists: re-scoring settled work is an unsettle-first
// decision, not a button.
//
// Safeguarding alerts (docs/safeguarding-alerts-design.md, D-4): an answer
// with a prompt-injection alert is not sent to the scorer unless the body
// says `{ "force": true }` — the queue's Score with AI anyway — which is
// recorded on the alert. The body is optional (the queue's plain Score with
// AI / Re-run AI posts none).
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { responseId } = await ctx.params;
  if (!UUID_RE.test(responseId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
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

  // Lazy screening: an answer handed in before screening shipped, or whose
  // hand-in screening failed, is screened now so the withhold below sees it.
  // A no-op when screening is off or the answer is already screened.
  const db = getDb();
  await screenResponse(db, chain.response.id);
  const alert = await injectionAlertFor(db, chain.response.id);
  if (alert) {
    if (!(await readForce(req))) {
      return NextResponse.json(
        {
          ok: false,
          error: "injection_flagged",
          detail:
            "This answer looks like it tries to instruct the AI scorer, so AI scoring is paused. Read it, then choose Score with AI anyway if you still want an AI proposal.",
        },
        { status: 409 },
      );
    }
    await recordAiForced(db, chain.response.id, auth.session.sub);
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
        {
          ok: false,
          error: "blocked_by_guardrail",
          // The queue shows `detail` in place of the code. Only the output
          // check blocks on this surface (inputMode "record"), so it is the
          // AI's own feedback text that was stopped.
          detail:
            "The AI safety filter stopped the feedback written for this essay. Score it by hand with the rubric.",
        },
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

// `{ "force": true }` or nothing. An empty or unparseable body is "no force"
// rather than a 400: the queue has always posted this route bodiless.
async function readForce(req: Request): Promise<boolean> {
  try {
    const text = await req.text();
    if (!text.trim()) return false;
    const body = JSON.parse(text) as unknown;
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { force?: unknown }).force === true
    );
  } catch {
    return false;
  }
}
