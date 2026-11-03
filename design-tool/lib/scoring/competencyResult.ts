// Competency assessments (docs/competency-assessment-design.md, slice 1): the
// Pass / Needs Revision / No Score result, derived from a final score.
//
// Derived, never stored: the score row is the record, and a result kept beside
// it could disagree with it after a Change score. The rule is the district's:
// a Pass needs at least `minPoints` on EVERY rubric criterion (3 on every OSPI
// task), so one weak row is a Needs Revision however strong the others are.
import type { Rubric } from "@secure-test/schema";

export const COMPETENCY_RESULTS = ["pass", "needs_revision", "no_score"] as const;
export type CompetencyResult = (typeof COMPETENCY_RESULTS)[number];

// The OSPI No Score conditions, as the scorer picks them. Carried on the final
// score's `rationale.no_score_reason`; the write path is a later slice.
export const NO_SCORE_REASONS = [
  "unintelligible",
  "not_english",
  "off_topic",
  "off_purpose",
  "copied",
] as const;
export type NoScoreReason = (typeof NO_SCORE_REASONS)[number];

interface CriterionPick {
  criterion_id: string;
  points: number;
}

function picksOf(rationale: unknown): CriterionPick[] | null {
  if (!rationale || typeof rationale !== "object") return null;
  const raw = (rationale as { criterion_scores?: unknown }).criterion_scores;
  if (!Array.isArray(raw)) return null;
  const picks: CriterionPick[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { criterion_id, points } = entry as { criterion_id?: unknown; points?: unknown };
    if (typeof criterion_id !== "string" || typeof points !== "number") return null;
    picks.push({ criterion_id, points });
  }
  return picks;
}

function noScoreReasonOf(rationale: unknown): NoScoreReason | null {
  if (!rationale || typeof rationale !== "object") return null;
  const reason = (rationale as { no_score_reason?: unknown }).no_score_reason;
  return (NO_SCORE_REASONS as readonly unknown[]).includes(reason)
    ? (reason as NoScoreReason)
    : null;
}

/**
 * The result of one final score on a competency assessment's final response.
 *
 * Returns null when no result can be derived — the score has no per-criterion
 * picks (a bare-points override), or a rubric criterion has no pick — rather
 * than guessing: an incomplete score is a scoring problem for Assessment to
 * see, not a Needs Revision for the student.
 */
export function deriveCompetencyResult(
  rubric: Rubric,
  rationale: unknown,
  minPoints: number,
): CompetencyResult | null {
  if (noScoreReasonOf(rationale)) return "no_score";
  const picks = picksOf(rationale);
  if (!picks) return null;
  const byCriterion = new Map(picks.map((p) => [p.criterion_id, p.points]));
  let pass = true;
  for (const criterion of rubric.criteria) {
    const points = byCriterion.get(criterion.id);
    if (points === undefined) return null;
    if (points < minPoints) pass = false;
  }
  return pass ? "pass" : "needs_revision";
}
