import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  scores,
  type ItemRow,
  type ItemType,
} from "@/db/schema";
import { effectiveScoringMethod } from "@/lib/api/items";
import { aiScoreResponse } from "@/lib/scoring/aiScoreResponse";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

// Is this item one the AI scorer targets at all? (essay + ai/hybrid)
function isAiEligible(item: ItemRow): boolean {
  if (item.type !== "essay") return false;
  const method = effectiveScoringMethod(item.type as ItemType, item.config);
  return method === "ai" || method === "hybrid";
}

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

// Slice 38: AI-score one submitted attempt's essay responses whose items
// declare scoring_method ai or hybrid. Scoring semantics live in
// lib/scoring/aiScoreResponse.ts (shared with the slice-39 per-response
// re-run). This route's own policy: a response that already has ANY score
// row (proposed or final) is skipped — re-proposing is the explicit
// slice-39 re-run action, not silent accumulation on every call.
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .limit(1);
  if (!attempt) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, attempt.assessment_id))
    .limit(1);
  if (!assessment || assessment.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (attempt.status !== "submitted") {
    return NextResponse.json(
      { ok: false, error: "attempt_not_submitted" },
      { status: 400 },
    );
  }

  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, assessment.id));
  const itemsById = new Map(itemRows.map((i) => [i.id, i]));

  const responseRows = await db
    .select()
    .from(responses)
    .where(eq(responses.attempt_id, attempt.id));

  const alreadyScoredIds = new Set<string>();
  if (responseRows.length > 0) {
    const existing = await db
      .select({ response_id: scores.response_id })
      .from(scores)
      .where(
        inArray(
          scores.response_id,
          responseRows.map((r) => r.id),
        ),
      );
    for (const row of existing) alreadyScoredIds.add(row.response_id);
  }

  let scoredProposed = 0;
  let scoredFinal = 0;
  let alreadyScored = 0;
  let skippedNotAi = 0;
  let skippedUnscorable = 0;
  let blocked = 0;
  let providerErrors = 0;

  for (const response of responseRows) {
    const item = itemsById.get(response.item_id);
    if (!item) {
      skippedUnscorable++;
      continue;
    }
    if (!isAiEligible(item)) {
      skippedNotAi++;
      continue;
    }
    if (alreadyScoredIds.has(response.id)) {
      alreadyScored++;
      continue;
    }
    const outcome = await aiScoreResponse({
      item,
      response,
      ownerSub: auth.session.sub,
    });
    switch (outcome.kind) {
      case "scored":
        if (outcome.status === "final") scoredFinal++;
        else scoredProposed++;
        break;
      case "not_ai":
        skippedNotAi++;
        break;
      case "unscorable":
        skippedUnscorable++;
        break;
      case "blocked":
        blocked++;
        break;
      case "provider_error":
        providerErrors++;
        break;
      case "already_final":
        // Lost a race to a concurrent final — the response IS scored.
        alreadyScored++;
        break;
    }
  }

  return NextResponse.json({
    ok: true,
    scored_proposed: scoredProposed,
    scored_final: scoredFinal,
    already_scored: alreadyScored,
    skipped_not_ai: skippedNotAi,
    skipped_unscorable: skippedUnscorable,
    blocked,
    provider_errors: providerErrors,
    total_responses: responseRows.length,
  });
}
