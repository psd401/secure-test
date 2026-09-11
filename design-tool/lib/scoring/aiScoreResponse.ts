import { ItemResponseSchema } from "@secure-test/schema";
import { getDb } from "@/db/client";
import {
  scores,
  type ItemRow,
  type ItemType,
  type ResponseRow,
} from "@/db/schema";
import { getEssayScorerProvider } from "@/lib/ai/essayScorer/provider";
import {
  HYBRID_AUTO_FINALIZE_CONFIDENCE,
  isScorableRubricStyle,
  scoringView,
  validateAgainstRubric,
} from "@/lib/ai/essayScorer/scoreCore";
import { effectiveScoringMethod } from "@/lib/api/items";
import { runGuarded } from "@/lib/safeguarding/guard";

// Slice 39 refactor: the score-one-response core shared by the attempt-wide
// score-ai route (slice 38) and the per-response re-run action (slice 39).
// Policy that differs between callers stays in the routes: the attempt-wide
// run skips responses that already have any score row; the explicit re-run
// deliberately adds another proposed row (but never past an existing final —
// its route 409s first).
//
// Semantics (confirmed 2026-07-09): ai → status=proposed always; hybrid →
// final at confidence >= HYBRID_AUTO_FINALIZE_CONFIDENCE, else proposed.

export type AiScoreOutcome =
  | { kind: "scored"; status: "proposed" | "final" }
  | { kind: "not_ai" }
  | { kind: "unscorable" }
  | { kind: "blocked" }
  | { kind: "provider_error" }
  // Review fix (2026-08-14): a hybrid auto-finalize that loses the race to
  // a concurrent final is its own outcome — previously the unique-index
  // violation landed in the catch and was miscounted as provider_error.
  | { kind: "already_final" };

export async function aiScoreResponse(opts: {
  item: ItemRow;
  response: ResponseRow;
  ownerSub: string;
}): Promise<AiScoreOutcome> {
  const { item, response, ownerSub } = opts;
  const method = effectiveScoringMethod(item.type as ItemType, item.config);
  if (item.type !== "essay" || (method !== "ai" && method !== "hybrid")) {
    return { kind: "not_ai" };
  }
  const rubric = item.config.rubric;
  if (!rubric || !isScorableRubricStyle(rubric)) {
    // The write boundary requires a rubric for ai/hybrid. Every style is
    // scorable since slice 4 (single_point through the derived ladder), so
    // in practice only a missing rubric lands here — the style question is
    // still asked through scoreCore rather than assumed here.
    return { kind: "unscorable" };
  }
  // D-5: the gate, the prompt and the bounds check all run against the
  // scoring view; the stored criterion_scores therefore carry the derived
  // `<target>.meets` ids for a single-point rubric.
  const view = scoringView(rubric);
  const parsed = ItemResponseSchema.safeParse(response.response);
  if (!parsed.success || parsed.data.type !== "essay" || !parsed.data.text.trim()) {
    return { kind: "unscorable" };
  }
  const responseText = parsed.data.text;
  const provider = getEssayScorerProvider();

  try {
    const outcome = await runGuarded({
      surface: "essay-score",
      ownerSub,
      inputText: responseText,
      run: () =>
        provider.scoreEssay({
          stem: item.stem,
          response_text: responseText,
          rubric,
        }),
      outputText: (r) =>
        [r.overall_rationale, ...r.criterion_scores.map((c) => c.rationale)].join(
          "\n",
        ),
    });
    if (!outcome.ok) {
      return { kind: "blocked" };
    }
    const result = outcome.result;
    const bounds = validateAgainstRubric(result, view);
    if (!bounds.valid) {
      return { kind: "provider_error" };
    }
    const finalize =
      method === "hybrid" && result.confidence >= HYBRID_AUTO_FINALIZE_CONFIDENCE;
    const status = finalize ? ("final" as const) : ("proposed" as const);
    const db = getDb();
    const inserted = await db
      .insert(scores)
      .values({
        response_id: response.id,
        method: "ai",
        points: result.points,
        max_points: result.max_points,
        rationale: {
          criterion_scores: result.criterion_scores,
          overall_rationale: result.overall_rationale,
          confidence: result.confidence,
        },
        scorer: provider.id,
        status,
      })
      .onConflictDoNothing()
      .returning({ id: scores.id });
    if (inserted.length === 0) {
      // Only a status='final' insert can conflict (the unique index is
      // partial on finals) — a concurrent request finalized first.
      return { kind: "already_final" };
    }
    return { kind: "scored", status };
  } catch (err) {
    console.error(`essay scoring failed for response ${response.id}`, err);
    return { kind: "provider_error" };
  }
}
