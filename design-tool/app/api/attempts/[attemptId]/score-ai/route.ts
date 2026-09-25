import { NextResponse } from "next/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  items,
  responses,
  scores,
  type ItemRow,
  type ItemType
} from "@/db/schema";
import { effectiveScoringMethod } from "@/lib/api/items";
import { aiScoreResponse } from "@/lib/scoring/aiScoreResponse";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAttempt } from "@/lib/api/access";
import { injectionAlertFor } from "@/lib/safeguarding/alerts";
import { screenResponse } from "@/lib/safeguarding/screening/screen";

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
//
// Safeguarding alerts (D-4): a response with an unforced prompt-injection
// alert is withheld from this run (counted in `withheld`); only the
// per-response route's explicit force releases it.
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAttempt(db, auth.session, attemptId, "edit");
  if (!access.ok) return access.response;
  const attempt = access.attempt;
  const assessment = access.assessment;
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
        // A response the corpus runner has scored has NOT been scored for
        // the teacher (docs/scoring-corpus-design.md slice 1) — a research
        // row must not make this run skip it.
        and(
          inArray(
            scores.response_id,
            responseRows.map((r) => r.id),
          ),
          ne(scores.status, "research"),
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
  let withheld = 0;

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
    // Lazy screening (a no-op when off or already screened), then D-4.
    await screenResponse(db, response.id);
    if (await injectionAlertFor(db, response.id)) {
      withheld++;
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
    withheld,
    provider_errors: providerErrors,
    total_responses: responseRows.length,
  });
}
