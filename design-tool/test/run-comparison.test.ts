// Slice 2 of docs/scoring-corpus-design.md: the pure comparison maths behind
// scripts/compare-runs.ts. Hand-built rows only — no DB, no provider.
import { describe, expect, test } from "bun:test";
import { HYBRID_AUTO_FINALIZE_CONFIDENCE } from "../lib/ai/essayScorer/scoreCore";
import {
  comparisonToCsv,
  compareRun,
  type ComparisonPair,
} from "../lib/reporting/runComparison";

const ai = (
  points: number,
  extra: { levels?: Record<string, string>; confidence?: number } = {},
) => ({
  points,
  max_points: 4,
  rationale: {
    ...(extra.levels
      ? {
          criterion_scores: Object.entries(extra.levels).map(([criterion_id, level_id]) => ({
            criterion_id,
            level_id,
            points: 1,
            rationale: "because",
          })),
        }
      : {}),
    overall_rationale: "ok",
    ...(extra.confidence !== undefined ? { confidence: extra.confidence } : {}),
  },
});

const human = (points: number, levels?: Record<string, string>) => ({
  points,
  max_points: 4,
  rationale: {
    ...(levels
      ? {
          criterion_scores: Object.entries(levels).map(([criterion_id, level_id]) => ({
            criterion_id,
            level_id,
            points: 1,
            rationale: "",
          })),
        }
      : {}),
    note: "seen",
  },
});

const pair = (
  n: number,
  research: ComparisonPair["research"],
  humanScore: ComparisonPair["human"],
): ComparisonPair => ({
  response_id: `r${n}`,
  item_id: `i${n}`,
  research,
  human: humanScore,
});

const input = (pairs: ComparisonPair[]) => ({
  label: "run A",
  provider_id: "mock",
  prompt_version: "2026-09-14",
  pairs,
});

describe("compareRun", () => {
  test("an empty run reports zeroes and null rates, never NaN", () => {
    const c = compareRun(input([]));
    expect(c.n).toBe(0);
    expect(c.with_human_final).toBe(0);
    expect(c.exact_agreement).toBeNull();
    expect(c.mean_abs_points_diff).toBeNull();
    expect(c.mean_abs_diff_fraction).toBeNull();
    expect(c.criterion).toEqual({ pairs: 0, compared: 0, agreed: 0, rate: null });
    expect(c.hybrid_auto_finalize_rate).toBeNull();
    expect(c.hybrid_threshold).toBe(HYBRID_AUTO_FINALIZE_CONFIDENCE);
  });

  test("points agreement, mean gap and the scale-free gap", () => {
    const c = compareRun(
      input([
        pair(1, ai(3), human(3)), // exact
        pair(2, ai(4), human(2)), // 2 off
        pair(3, ai(1), human(2)), // 1 off
        pair(4, ai(2), null), // no final — counted in n only
      ]),
    );
    expect(c.n).toBe(4);
    expect(c.with_human_final).toBe(3);
    expect(c.exact_agreement).toBeCloseTo(1 / 3, 10);
    expect(c.mean_abs_points_diff).toBeCloseTo((0 + 2 + 1) / 3, 10);
    // /4 per row, so the mean fraction is the mean gap over the max.
    expect(c.mean_abs_diff_fraction).toBeCloseTo(1 / 4, 10);
  });

  test("no finals at all: n stands, every human-facing rate is null", () => {
    const c = compareRun(input([pair(1, ai(3), null), pair(2, ai(1), null)]));
    expect(c.n).toBe(2);
    expect(c.with_human_final).toBe(0);
    expect(c.exact_agreement).toBeNull();
    expect(c.mean_abs_points_diff).toBeNull();
    expect(c.criterion.compared).toBe(0);
  });

  test("float points compare with tolerance", () => {
    const c = compareRun(input([pair(1, ai(0.1 + 0.2), human(0.3))]));
    expect(c.exact_agreement).toBe(1);
  });

  test("per-criterion agreement counts only criteria BOTH sides scored", () => {
    const c = compareRun(
      input([
        // two agree, one differs
        pair(
          1,
          ai(3, { levels: { focus: "l2", evidence: "l2", style: "l1" } }),
          human(3, { focus: "l2", evidence: "l2", style: "l3" }),
        ),
        // the human scored a criterion the AI did not mention: not compared
        pair(
          2,
          ai(2, { levels: { focus: "l1" } }),
          human(2, { focus: "l1", evidence: "l2" }),
        ),
      ]),
    );
    expect(c.criterion.pairs).toBe(2);
    expect(c.criterion.compared).toBe(4);
    expect(c.criterion.agreed).toBe(3);
    expect(c.criterion.rate).toBeCloseTo(0.75, 10);
  });

  test("one side missing criterion_scores drops the pair from the criterion stats only", () => {
    const c = compareRun(
      input([
        // holistic human override: bare points, no criterion_scores
        pair(1, ai(3, { levels: { focus: "l2" } }), human(3)),
        // AI row with no criterion_scores either (defensive: never written today)
        pair(2, ai(2), human(2, { focus: "l1" })),
        pair(3, ai(1, { levels: { focus: "l1" } }), human(1, { focus: "l1" })),
      ]),
    );
    expect(c.with_human_final).toBe(3);
    expect(c.exact_agreement).toBe(1);
    expect(c.criterion).toEqual({ pairs: 1, compared: 1, agreed: 1, rate: 1 });
  });

  test("the hybrid auto-finalize rate is over the rows that carry a confidence", () => {
    const above = HYBRID_AUTO_FINALIZE_CONFIDENCE;
    const below = HYBRID_AUTO_FINALIZE_CONFIDENCE - 0.1;
    const c = compareRun(
      input([
        pair(1, ai(3, { confidence: above }), human(3)), // at the threshold: finalizes
        pair(2, ai(3, { confidence: below }), human(3)),
        pair(3, ai(3, { confidence: 1 }), null),
        pair(4, ai(3), human(3)), // no confidence: not counted either way
      ]),
    );
    expect(c.hybrid_confidence_rows).toBe(3);
    expect(c.hybrid_auto_finalize_rate).toBeCloseTo(2 / 3, 10);
  });

  test("a garbage rationale is read defensively, not thrown on", () => {
    const c = compareRun(
      input([
        pair(
          1,
          { points: 1, max_points: 4, rationale: "not an object" },
          { points: 1, max_points: 4, rationale: null },
        ),
        pair(
          2,
          {
            points: 1,
            max_points: 4,
            rationale: { criterion_scores: [{ criterion_id: 7 }], confidence: "high" },
          },
          { points: 2, max_points: 4, rationale: { criterion_scores: {} } },
        ),
      ]),
    );
    expect(c.n).toBe(2);
    expect(c.criterion.compared).toBe(0);
    expect(c.hybrid_confidence_rows).toBe(0);
  });

  test("a zero max_points row is skipped by the fraction only", () => {
    const c = compareRun(
      input([
        pair(1, { points: 1, max_points: 0, rationale: {} }, { points: 2, max_points: 0, rationale: {} }),
        pair(2, ai(1), human(3)),
      ]),
    );
    expect(c.mean_abs_points_diff).toBeCloseTo(1.5, 10);
    expect(c.mean_abs_diff_fraction).toBeCloseTo(0.5, 10);
  });
});

describe("comparisonToCsv", () => {
  test("one header plus one row per run; nulls are blank", () => {
    const a = compareRun(input([pair(1, ai(3, { confidence: 0.9 }), human(3))]));
    const b = compareRun({ ...input([]), label: 'run "B", second' });
    const csv = comparisonToCsv([a, b]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.startsWith("label,provider_id,prompt_version,n,")).toBe(true);
    expect(lines[1]!.startsWith("run A,mock,2026-09-14,1,1,1,0,0,")).toBe(true);
    // The quoted label survives, and the empty run's rates are blank fields.
    expect(lines[2]!).toContain('"run ""B"", second"');
    expect(lines[2]!).toContain(",,");
  });
});
