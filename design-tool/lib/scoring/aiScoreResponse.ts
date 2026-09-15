import {
  ItemResponseSchema,
  type Rubric,
  type ScoringMethod,
} from "@secure-test/schema";
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
import type {
  EssayScorerProvider,
  ScoreEssayResult,
} from "@/lib/ai/essayScorer/types";
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
  | { kind: "unscorable"; reason: UnscorableReason }
  | { kind: "blocked" }
  | { kind: "provider_error" }
  // Review fix (2026-08-14): a hybrid auto-finalize that loses the race to
  // a concurrent final is its own outcome — previously the unique-index
  // violation landed in the catch and was miscounted as provider_error.
  | { kind: "already_final" };

// Slice 2 of docs/scoring-corpus-design.md: the "run the provider and
// validate its output" half, extracted so the corpus runner uses the SAME
// guarded path as the live route (guardrail surface `essay-score`,
// `ownerSub` = the assessment owner so the `ai_usage` line attributes spend
// as today) and only the persistence differs. aiScoreResponse's behaviour is
// unchanged: it maps a bounds failure onto `provider_error` exactly as
// before.

/** Why an essay could not be sent to the scorer (2026-09-14, corpus slice 3
 * reading): the runner's operator needs the word, not a query. */
export type UnscorableReason = "no_rubric" | "empty_response";

export type EssayScoreAttempt =
  | {
      kind: "ok";
      result: ScoreEssayResult;
      /** The rubric as authored — what a research row snapshots. */
      rubric: Rubric;
      /** D-5's scoring view: what the model saw and what bounds ran against. */
      view: Rubric;
      provider: EssayScorerProvider;
      method: ScoringMethod;
    }
  | { kind: "not_ai"; method: ScoringMethod }
  | { kind: "unscorable"; reason: UnscorableReason }
  | { kind: "blocked" }
  | { kind: "provider_error" }
  | { kind: "bounds"; reason: string };

export async function runEssayScorer(opts: {
  item: ItemRow;
  response: ResponseRow;
  ownerSub: string;
  /**
   * Which effective scoring methods this caller accepts. The live path takes
   * ai/hybrid only; the corpus runner also re-scores `human` essays, which is
   * the whole point of a run against teacher finals.
   */
  allowedMethods?: readonly ScoringMethod[];
  /** Explicit provider (the runner's `--provider`/`--model`); env default otherwise. */
  provider?: EssayScorerProvider;
}): Promise<EssayScoreAttempt> {
  const { item, response, ownerSub } = opts;
  const allowed = opts.allowedMethods ?? (["ai", "hybrid"] as const);
  const method = effectiveScoringMethod(item.type as ItemType, item.config);
  if (item.type !== "essay" || !allowed.includes(method)) {
    return { kind: "not_ai", method };
  }
  const rubric = item.config.rubric;
  if (!rubric || !isScorableRubricStyle(rubric)) {
    // The write boundary requires a rubric for ai/hybrid. Every style is
    // scorable since slice 4 (single_point through the derived ladder), so
    // in practice only a missing rubric lands here — the style question is
    // still asked through scoreCore rather than assumed here.
    return { kind: "unscorable", reason: "no_rubric" };
  }
  // D-5: the gate, the prompt and the bounds check all run against the
  // scoring view; the stored criterion_scores therefore carry the derived
  // `<target>.meets` ids for a single-point rubric.
  const view = scoringView(rubric);
  const parsed = ItemResponseSchema.safeParse(response.response);
  if (!parsed.success || parsed.data.type !== "essay" || !parsed.data.text.trim()) {
    return { kind: "unscorable", reason: "empty_response" };
  }
  const responseText = parsed.data.text;
  const provider = opts.provider ?? getEssayScorerProvider();

  try {
    const outcome = await runGuarded({
      surface: "essay-score",
      ownerSub,
      inputText: responseText,
      run: () =>
        provider.scoreEssay(
          {
            stem: item.stem,
            response_text: responseText,
            rubric,
          },
          ownerSub,
        ),
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
      return { kind: "bounds", reason: bounds.reason };
    }
    return { kind: "ok", result, rubric, view, provider, method };
  } catch (err) {
    console.error(`essay scoring failed for response ${response.id}`, err);
    return { kind: "provider_error" };
  }
}

export async function aiScoreResponse(opts: {
  item: ItemRow;
  response: ResponseRow;
  ownerSub: string;
}): Promise<AiScoreOutcome> {
  const { response } = opts;
  const attempt = await runEssayScorer(opts);
  if (attempt.kind !== "ok") {
    // A bounds failure was and stays a provider_error to this caller.
    return attempt.kind === "bounds" ? { kind: "provider_error" } : attempt;
  }
  const { result, provider, method } = attempt;
  const finalize =
    method === "hybrid" && result.confidence >= HYBRID_AUTO_FINALIZE_CONFIDENCE;
  const status = finalize ? ("final" as const) : ("proposed" as const);
  const db = getDb();
  // The insert stays inside a catch, as it was before the slice-2 extraction:
  // a failed write is this caller's provider_error, not a thrown route 500.
  try {
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
        // Slice 1 of docs/scoring-corpus-design.md: live proposals carry
        // the prompt's version too (no run, no rubric snapshot), so they
        // are comparable to a later corpus run without a join on dates.
        prompt_version: provider.promptVersion,
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
    console.error(`essay score insert failed for response ${response.id}`, err);
    return { kind: "provider_error" };
  }
}
