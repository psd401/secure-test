import { HYBRID_AUTO_FINALIZE_CONFIDENCE } from "@/lib/ai/essayScorer/scoreCore";

// Slice 2 of docs/scoring-corpus-design.md: the pure comparison maths behind
// scripts/compare-runs.ts. One run vs the teacher finals answers "is this
// prompt good enough"; two runs side by side answer "which model".
//
// Deliberately identifier-free: a pair carries the response and item ids only
// (the note's last "deliberately does not do"), and nothing here reaches the
// DB — the script loads the rows.
//
// THE `criterion_scores` SHAPE THIS RELIES ON. Both sides write the same
// array under `rationale.criterion_scores`, so one reader serves both:
//   - the AI path (lib/scoring/aiScoreResponse.ts, and the corpus runner)
//     stores `{criterion_scores, overall_rationale, confidence}`, where each
//     entry is `{criterion_id, level_id, points, rationale}` — validated by
//     `CriterionScore` in lib/ai/essayScorer/types.ts and bounds-checked
//     against the SCORING VIEW, so a single-point rubric's ids are the derived
//     `<target>.below|.meets|.exceeds`;
//   - the human final (app/api/responses/[responseId]/score/route.ts) stores
//     `{criterion_scores?, note?}`, the array being `ManualScoreBody`'s
//     `{criterion_id, level_id, points, rationale}` — validated against the
//     same scoring view, so the level ids are directly comparable.
// `criterion_scores` is OPTIONAL on the human side (a teacher may override
// holistically with bare points), which is why per-criterion agreement is
// reported over the pairs where BOTH sides carry it rather than over n.
// `confidence` exists on the AI side only (`ScoreEssayResult.confidence`).

export interface ScorePayload {
  points: number;
  max_points: number;
  /** The score row's `rationale` jsonb, read defensively. */
  rationale: unknown;
}

export interface ComparisonPair {
  response_id: string;
  item_id: string;
  /** The run's `research` row. */
  research: ScorePayload;
  /** The response's human final, when it has one. */
  human: ScorePayload | null;
}

export interface RunComparisonInput {
  label: string;
  provider_id: string;
  prompt_version: string;
  pairs: readonly ComparisonPair[];
}

export interface RunComparison {
  label: string;
  provider_id: string;
  prompt_version: string;
  /** Research rows in the run. */
  n: number;
  /** How many of them sit on a response with a human final. */
  with_human_final: number;
  /** Fraction of those whose points match the final exactly. null when none. */
  exact_agreement: number | null;
  /** Mean |AI points − human points| over those. null when none. */
  mean_abs_points_diff: number | null;
  /**
   * Mean |AI − human| / max_points over those — the scale-free version, so
   * a 1-point gap on a 4-point rubric and on a 24-point rubric are
   * comparable. The human row's max is the denominator (it is the one the
   * teacher's number is out of); rows with max_points <= 0 are skipped.
   */
  mean_abs_diff_fraction: number | null;
  /** Per-criterion level agreement where BOTH sides carry criterion_scores. */
  criterion: {
    /** Pairs contributing (both sides carried the array). */
    pairs: number;
    /** Criteria compared across those pairs. */
    compared: number;
    agreed: number;
    rate: number | null;
  };
  /**
   * The share of the run's rows whose own confidence would have
   * auto-finalized on a hybrid item at HYBRID_AUTO_FINALIZE_CONFIDENCE —
   * "how much of this would a teacher never have seen". Over the rows that
   * carry a numeric confidence.
   */
  hybrid_auto_finalize_rate: number | null;
  hybrid_confidence_rows: number;
  hybrid_threshold: number;
}

interface CriterionScoreLike {
  criterion_id: string;
  level_id: string;
}

function criterionScores(rationale: unknown): CriterionScoreLike[] | null {
  if (typeof rationale !== "object" || rationale === null) return null;
  const raw = (rationale as { criterion_scores?: unknown }).criterion_scores;
  if (!Array.isArray(raw)) return null;
  const out: CriterionScoreLike[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { criterion_id, level_id } = entry as Record<string, unknown>;
    if (typeof criterion_id === "string" && typeof level_id === "string") {
      out.push({ criterion_id, level_id });
    }
  }
  return out.length > 0 ? out : null;
}

function confidence(rationale: unknown): number | null {
  if (typeof rationale !== "object" || rationale === null) return null;
  const raw = (rationale as { confidence?: unknown }).confidence;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Points equality with the same float tolerance the rubric bounds check uses. */
const EPS = 1e-6;

export function compareRun(input: RunComparisonInput): RunComparison {
  const withFinal = input.pairs.filter(
    (p): p is ComparisonPair & { human: ScorePayload } => p.human !== null,
  );

  const diffs = withFinal.map((p) => Math.abs(p.research.points - p.human.points));
  const fractions = withFinal
    .filter((p) => p.human.max_points > 0)
    .map((p) => Math.abs(p.research.points - p.human.points) / p.human.max_points);
  const exact = withFinal.filter(
    (p) => Math.abs(p.research.points - p.human.points) <= EPS,
  ).length;

  let criterionPairs = 0;
  let compared = 0;
  let agreed = 0;
  for (const p of withFinal) {
    const ai = criterionScores(p.research.rationale);
    const human = criterionScores(p.human.rationale);
    if (!ai || !human) continue;
    const humanById = new Map(human.map((c) => [c.criterion_id, c.level_id]));
    let contributed = 0;
    for (const c of ai) {
      const humanLevel = humanById.get(c.criterion_id);
      if (humanLevel === undefined) continue;
      contributed += 1;
      compared += 1;
      if (humanLevel === c.level_id) agreed += 1;
    }
    if (contributed > 0) criterionPairs += 1;
  }

  const confidences = input.pairs
    .map((p) => confidence(p.research.rationale))
    .filter((c): c is number => c !== null);
  const wouldFinalize = confidences.filter(
    (c) => c >= HYBRID_AUTO_FINALIZE_CONFIDENCE,
  ).length;

  return {
    label: input.label,
    provider_id: input.provider_id,
    prompt_version: input.prompt_version,
    n: input.pairs.length,
    with_human_final: withFinal.length,
    exact_agreement: withFinal.length === 0 ? null : exact / withFinal.length,
    mean_abs_points_diff: mean(diffs),
    mean_abs_diff_fraction: mean(fractions),
    criterion: {
      pairs: criterionPairs,
      compared,
      agreed,
      rate: compared === 0 ? null : agreed / compared,
    },
    hybrid_auto_finalize_rate:
      confidences.length === 0 ? null : wouldFinalize / confidences.length,
    hybrid_confidence_rows: confidences.length,
    hybrid_threshold: HYBRID_AUTO_FINALIZE_CONFIDENCE,
  };
}

const CSV_HEADER = [
  "label",
  "provider_id",
  "prompt_version",
  "n",
  "with_human_final",
  "exact_agreement",
  "mean_abs_points_diff",
  "mean_abs_diff_fraction",
  "criterion_pairs",
  "criteria_compared",
  "criteria_agreed",
  "criterion_agreement",
  "hybrid_auto_finalize_rate",
  "hybrid_confidence_rows",
  "hybrid_threshold",
] as const;

function csvField(value: string): string {
  // Same spreadsheet-formula neutralization as resultsToCsv.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const num = (v: number | null): string => (v === null ? "" : String(v));

/** One CSV row per run. */
export function comparisonToCsv(rows: readonly RunComparison[]): string {
  const lines = [CSV_HEADER.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.label),
        csvField(r.provider_id),
        csvField(r.prompt_version),
        String(r.n),
        String(r.with_human_final),
        num(r.exact_agreement),
        num(r.mean_abs_points_diff),
        num(r.mean_abs_diff_fraction),
        String(r.criterion.pairs),
        String(r.criterion.compared),
        String(r.criterion.agreed),
        num(r.criterion.rate),
        num(r.hybrid_auto_finalize_rate),
        String(r.hybrid_confidence_rows),
        String(r.hybrid_threshold),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
