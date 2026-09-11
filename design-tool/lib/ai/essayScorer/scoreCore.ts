import type { Rubric } from "@secure-test/schema";
import { ScoreEssayResult } from "./types";

// Shared between the mock and Bedrock providers + the score-ai route.

// Hybrid auto-finalize gate (definition confirmed 2026-07-09): hybrid
// items finalize AI scores at/above this confidence; below it (and for
// ai-method items always) the score lands status=proposed for slice 39's
// review queue.
export const HYBRID_AUTO_FINALIZE_CONFIDENCE = 0.85;

export const ESSAY_SCORE_MAX_TOKENS = 2000;

// Every rubric style is AI-scorable (slice 4 of docs/rubric-upload-design.md,
// D-5). analytic + holistic are level selection as authored; single_point
// becomes level selection through the derived below/meets/exceeds ladder
// `scoringView` builds. The export stays because aiScoreResponse still asks
// the question at the point where a missing rubric is also caught; it is
// now always true.
export function isScorableRubricStyle(_rubric: Rubric): boolean {
  return true;
}

/** The three synthetic levels a single-point target expands into. */
export const SINGLE_POINT_LEVEL_SUFFIXES = ["below", "meets", "exceeds"] as const;

/**
 * D-5: what the scorer, the validators and the UIs see.
 *
 * analytic / holistic pass through unchanged. A single-point criterion
 * carries ONE level — the target, worth P — and scoring it means judging
 * below / at / above, so the view expands it into three levels:
 *   `<targetId>.below`   "Below target"   0
 *   `<targetId>.meets`   "Meets target"   P  (the target's descriptor)
 *   `<targetId>.exceeds` "Exceeds target" P
 * `exceeds` earns the same points as `meets` because a single-point
 * rubric's maximum IS the target; the value of the distinction is the
 * rationale. rubricMaxPoints is therefore unchanged by the expansion
 * (asserted in the tests).
 *
 * The view's style is reported as "analytic" so the result is a rubric
 * RubricSchema would accept (its superRefine requires exactly one level
 * per single_point criterion); nothing downstream reads the view's style,
 * and the prompt tells the model what the Below/Meets/Exceeds labels mean.
 */
export function scoringView(rubric: Rubric): Rubric {
  if (rubric.style !== "single_point") return rubric;
  return {
    ...rubric,
    style: "analytic",
    criteria: rubric.criteria.map((c) => {
      const target = c.levels[0]!;
      return {
        ...c,
        levels: [
          { id: `${target.id}.below`, label: "Below target", points: 0 },
          {
            id: `${target.id}.meets`,
            label: "Meets target",
            points: target.points,
            ...(target.descriptor ? { descriptor: target.descriptor } : {}),
          },
          { id: `${target.id}.exceeds`, label: "Exceeds target", points: target.points },
        ],
      };
    }),
  };
}

/**
 * Resolve a stored (possibly derived) level id against the scoring view, so
 * a UI can render "Meets target" for `t.meets` and the authored label for
 * every other style. null when the ids do not resolve — a rubric edited
 * after the score was written.
 */
export function describeLevel(
  rubric: Rubric,
  criterion_id: string,
  level_id: string,
): { label: string; points: number } | null {
  const view = scoringView(rubric);
  const criterion = view.criteria.find((c) => c.id === criterion_id);
  const level = criterion?.levels.find((l) => l.id === level_id);
  return level ? { label: level.label, points: level.points } : null;
}

export function rubricMaxPoints(rubric: Rubric): number {
  return rubric.criteria.reduce(
    (sum, c) => sum + Math.max(...c.levels.map((l) => l.points)),
    0,
  );
}

export const ESSAY_SCORE_SYSTEM_PROMPT = [
  "You are a careful K-12 assessment scorer. You will be given an essay",
  "prompt, a student's response, and a scoring rubric as JSON.",
  "Score the response against EVERY rubric criterion by choosing exactly",
  "one level per criterion.",
  "When a level is labelled Below / Meets / Exceeds target, the criterion",
  "states one target: judge which of the three applies and quote the",
  "evidence.",
  "Quote or reference specific evidence from the",
  "student's response in each rationale. Be fair and consistent; do not",
  "reward length over substance. Respond with ONLY a JSON object, no",
  "markdown fences, in this exact shape:",
  '{"criterion_scores":[{"criterion_id":"...","level_id":"...","points":N,',
  '"rationale":"..."}],"points":N,"max_points":N,"overall_rationale":"...",',
  '"confidence":N}',
  "points must equal the chosen level's points for each criterion; the",
  "top-level points is their sum; max_points is the rubric maximum;",
  "confidence is your 0-1 estimate of how defensible this scoring is",
  "(lower it for off-topic, ambiguous, very short, or borderline work).",
].join(" ");

export function buildEssayScoreUserPrompt(req: {
  stem: string;
  response_text: string;
  rubric: Rubric;
}): string {
  return [
    "ESSAY PROMPT:",
    req.stem,
    "",
    "RUBRIC (JSON):",
    JSON.stringify(req.rubric),
    "",
    "STUDENT RESPONSE:",
    req.response_text,
  ].join("\n");
}

// Strip optional markdown fences and parse the model's JSON, then
// Zod-validate the shape. Throws with errPrefix context on failure.
export function parseScoreResult(text: string, errPrefix: string) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new Error(`${errPrefix}: model did not return valid JSON`);
  }
  const parsed = ScoreEssayResult.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${errPrefix}: model JSON failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export type RubricBoundsError = { valid: false; reason: string };
export type RubricBoundsOk = { valid: true };

// Second validation pass: the Zod shape can't know the rubric, so check
// the selections against it — every criterion scored exactly once, chosen
// levels exist, per-criterion points equal the chosen level's points, and
// the sums hold (float-tolerant).
export function validateAgainstRubric(
  result: {
    criterion_scores: Array<{
      criterion_id: string;
      level_id: string;
      points: number;
    }>;
    points: number;
    max_points: number;
  },
  rubric: Rubric,
): RubricBoundsOk | RubricBoundsError {
  const EPS = 1e-6;
  const byId = new Map(rubric.criteria.map((c) => [c.id, c]));
  const seen = new Set<string>();
  let sum = 0;
  for (const cs of result.criterion_scores) {
    const criterion = byId.get(cs.criterion_id);
    if (!criterion) {
      return { valid: false, reason: `unknown criterion "${cs.criterion_id}"` };
    }
    if (seen.has(cs.criterion_id)) {
      return { valid: false, reason: `criterion "${cs.criterion_id}" scored twice` };
    }
    seen.add(cs.criterion_id);
    const level = criterion.levels.find((l) => l.id === cs.level_id);
    if (!level) {
      return {
        valid: false,
        reason: `unknown level "${cs.level_id}" for criterion "${cs.criterion_id}"`,
      };
    }
    if (Math.abs(cs.points - level.points) > EPS) {
      return {
        valid: false,
        reason: `points ${cs.points} != level "${cs.level_id}" points ${level.points}`,
      };
    }
    sum += level.points;
  }
  if (seen.size !== rubric.criteria.length) {
    return { valid: false, reason: "not every rubric criterion was scored" };
  }
  if (Math.abs(result.points - sum) > EPS) {
    return { valid: false, reason: `points ${result.points} != criterion sum ${sum}` };
  }
  const max = rubricMaxPoints(rubric);
  if (Math.abs(result.max_points - max) > EPS) {
    return { valid: false, reason: `max_points ${result.max_points} != rubric max ${max}` };
  }
  return { valid: true };
}
