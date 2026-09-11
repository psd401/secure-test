import { z } from "zod";
import { RubricSchema } from "@secure-test/schema";

// Slice 38: AI essay scoring (docs/phase-3-slices.md). The provider takes
// the essay prompt, the student's response text, and the item's rubric —
// the rubric is REQUIRED by construction (design-tool-plan.md:119): there
// is no request shape without one. Output is a per-criterion level
// selection with rationale; shape is Zod-validated here, and rubric-bounds
// validation (chosen levels actually exist, points arithmetic holds) is a
// second pass in scoreCore.ts.
//
// Scores produced from this result are written by the score-ai route:
// method 'ai'; status 'proposed' for ai items always, and for hybrid items
// 'final' only at/above the confidence threshold (scoreCore.ts) — the
// hybrid definition confirmed 2026-07-09.

export const ScoreEssayRequest = z.object({
  stem: z.string().min(1).max(10000),
  response_text: z.string().min(1).max(100000),
  rubric: RubricSchema,
});
export type ScoreEssayRequest = z.infer<typeof ScoreEssayRequest>;

export const CriterionScore = z.object({
  criterion_id: z.string().min(1),
  level_id: z.string().min(1),
  points: z.number().nonnegative(),
  rationale: z.string().max(2000),
});
export type CriterionScore = z.infer<typeof CriterionScore>;

export const ScoreEssayResult = z.object({
  criterion_scores: z.array(CriterionScore).min(1),
  points: z.number().nonnegative(),
  max_points: z.number().positive(),
  overall_rationale: z.string().min(1).max(4000),
  /** Model's own confidence, 0-1. Drives the hybrid auto-finalize gate. */
  confidence: z.number().min(0).max(1),
});
export type ScoreEssayResult = z.infer<typeof ScoreEssayResult>;

export interface EssayScorerProvider {
  /** Stable identifier persisted as scores.scorer for triage. */
  readonly id: string;
  /** `ownerSub` (docs/rubric-upload-design.md D-7): the ai_usage log field. */
  scoreEssay(
    req: ScoreEssayRequest,
    ownerSub?: string,
  ): Promise<ScoreEssayResult>;
}
