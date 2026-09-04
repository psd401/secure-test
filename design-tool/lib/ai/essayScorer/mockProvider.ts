import {
  rubricMaxPoints,
  isScorableRubricStyle,
} from "./scoreCore";
import type {
  EssayScorerProvider,
  ScoreEssayRequest,
  ScoreEssayResult,
} from "./types";

// Deterministic mock (default provider): picks each criterion's middle
// level, so tests and keyless dev get stable, rubric-valid output.
// Confidence defaults to 0.9 (above the hybrid auto-finalize gate) and is
// overridable per-call via MOCK_ESSAY_SCORER_CONFIDENCE so tests can
// exercise both sides of the hybrid threshold without module mocking.

export const mockEssayScorer: EssayScorerProvider = {
  id: "mock",

  async scoreEssay(req: ScoreEssayRequest): Promise<ScoreEssayResult> {
    if (!isScorableRubricStyle(req.rubric)) {
      throw new Error(
        `mock: rubric style "${req.rubric.style}" is not AI-scorable (analytic/holistic only)`,
      );
    }
    const envConfidence = Number(process.env.MOCK_ESSAY_SCORER_CONFIDENCE);
    const confidence =
      Number.isFinite(envConfidence) && envConfidence >= 0 && envConfidence <= 1
        ? envConfidence
        : 0.9;

    const criterion_scores = req.rubric.criteria.map((c) => {
      const level = c.levels[Math.floor(c.levels.length / 2)]!;
      return {
        criterion_id: c.id,
        level_id: level.id,
        points: level.points,
        rationale: `Mock: selected "${level.label}" for "${c.name}".`,
      };
    });
    return {
      criterion_scores,
      points: criterion_scores.reduce((s, c) => s + c.points, 0),
      max_points: rubricMaxPoints(req.rubric),
      overall_rationale:
        "Mock scoring: middle level chosen for every criterion. Replace with a real provider for meaningful scores.",
      confidence,
    };
  },
};
