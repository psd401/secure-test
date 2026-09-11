// Rubric upload slice 1 (docs/rubric-upload-design.md): the normaliser is
// where a model's loose rubric object becomes a `Rubric` the shared schema
// accepts. These are pure unit tests — no DB, no provider.
import { describe, expect, test } from "bun:test";
import {
  MAX_DESCRIPTOR_CHARS,
  PADDED_LEVEL_LABEL,
  RubricExtractError,
  normalizeRubric,
  parseRubricExtraction,
} from "../lib/ai/rubricExtractor/extractCore";

const criterion = (name: string, levels: unknown[]) => ({ name, levels });
const level = (label: string, points: number | null, descriptor?: string) => ({
  label,
  points,
  ...(descriptor ? { descriptor } : {}),
});

describe("parseRubricExtraction", () => {
  test("strips markdown fences and parses one object", () => {
    const raw = parseRubricExtraction(
      '```json\n{"style":"holistic","criteria":[]}\n```',
      "mock",
    ) as { style: string };
    expect(raw.style).toBe("holistic");
  });

  test("non-JSON → invalid_json; truncated → truncated", () => {
    expect(() => parseRubricExtraction("not json", "mock")).toThrow(/valid JSON/);
    try {
      parseRubricExtraction("{unclosed", "mock", { truncated: true });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RubricExtractError);
      expect((err as RubricExtractError).code).toBe("truncated");
    }
  });

  test("a JSON array is not a rubric object", () => {
    try {
      parseRubricExtraction("[]", "mock");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as RubricExtractError).code).toBe("invalid_json");
      expect((err as Error).message).toMatch(/not an object/);
    }
  });
});

describe("normalizeRubric: ids and empty criteria", () => {
  test("assigns c1… / l1… and drops criteria with no name or no levels", () => {
    const { rubric } = normalizeRubric({
      style: "analytic",
      criteria: [
        criterion("Claim", [level("Meets", 2), level("Beginning", 0)]),
        criterion("   ", [level("Meets", 2), level("Beginning", 0)]),
        criterion("No levels", []),
        criterion("Evidence", [level("Meets", 2), level("Beginning", 0)]),
      ],
    });
    expect(rubric.criteria.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(rubric.criteria.map((c) => c.name)).toEqual(["Claim", "Evidence"]);
    // Level ids are unique across the whole rubric, not restarted per
    // criterion — a stored score names a level id.
    expect(rubric.criteria.flatMap((c) => c.levels.map((l) => l.id))).toEqual([
      "l1",
      "l2",
      "l3",
      "l4",
    ]);
  });

  test("no usable criteria at all → invalid_output with issues", () => {
    try {
      normalizeRubric({ style: "analytic", criteria: [] });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RubricExtractError);
      expect((err as RubricExtractError).code).toBe("invalid_output");
      expect((err as RubricExtractError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeRubric: point ladders (D-3)", () => {
  test("all points missing → descending n-1 … 0, warned by name", () => {
    const { rubric, warnings } = normalizeRubric({
      style: "analytic",
      criteria: [
        criterion("Claim", [
          level("Exceeds", null),
          level("Meets", null),
          level("Approaching", null),
          level("Beginning", null),
        ]),
      ],
    });
    expect(rubric.criteria[0]!.levels.map((l) => l.points)).toEqual([3, 2, 1, 0]);
    const w = warnings.find((x) => x.code === "points_assigned");
    expect(w).toBeDefined();
    expect(w!.message).toContain('"Claim" → "Exceeds" = 3');
    expect(w!.message).toContain('"Beginning" = 0');
  });

  test("some points printed → linear fill between the printed neighbours", () => {
    const { rubric } = normalizeRubric({
      style: "analytic",
      criteria: [
        criterion("Claim", [
          level("Exceeds", 4),
          level("Meets", null),
          level("Approaching", null),
          level("Beginning", 1),
        ]),
      ],
    });
    expect(rubric.criteria[0]!.levels.map((l) => l.points)).toEqual([4, 3, 2, 1]);
  });

  test("printed neighbours only on one side → the printed run's own step continues", () => {
    const { rubric } = normalizeRubric({
      style: "analytic",
      criteria: [
        // Leading and trailing nulls around a printed 6 → 4 run (step -2).
        criterion("Claim", [
          level("A", null),
          level("B", 6),
          level("C", 4),
          level("D", null),
        ]),
      ],
    });
    expect(rubric.criteria[0]!.levels.map((l) => l.points)).toEqual([8, 6, 4, 2]);
  });

  test("a single printed level implies a step of 1, clamped at 0", () => {
    const { rubric } = normalizeRubric({
      style: "analytic",
      criteria: [
        criterion("Claim", [level("A", null), level("B", 1), level("C", null), level("D", null)]),
      ],
    });
    expect(rubric.criteria[0]!.levels.map((l) => l.points)).toEqual([2, 1, 0, 0]);
  });

  test("single_point: a target with no printed points gets 1", () => {
    const { rubric, warnings } = normalizeRubric({
      style: "single_point",
      criteria: [
        criterion("Claim", [level("Target", null, "States a clear claim.")]),
        criterion("Evidence", [level("Target", 3)]),
      ],
    });
    expect(rubric.style).toBe("single_point");
    expect(rubric.criteria.map((c) => c.levels[0]!.points)).toEqual([1, 3]);
    expect(warnings.some((w) => w.code === "points_assigned")).toBe(true);
  });
});

describe("normalizeRubric: few_levels, style_guess, truncation", () => {
  test("a one-level analytic criterion is padded with an empty 0-point level", () => {
    const { rubric, warnings } = normalizeRubric({
      style: "analytic",
      criteria: [
        criterion("Claim", [level("Meets", null, "States a clear claim.")]),
        criterion("Evidence", [level("Meets", 2), level("Beginning", 0)]),
      ],
    });
    const claim = rubric.criteria[0]!;
    expect(claim.levels.map((l) => l.label)).toEqual(["Meets", PADDED_LEVEL_LABEL]);
    expect(claim.levels.map((l) => l.points)).toEqual([1, 0]);
    expect(warnings.some((w) => w.code === "few_levels")).toBe(true);
  });

  test("style_inferred → style_guess warning; an unknown style is read off the shape", () => {
    const inferred = normalizeRubric({
      style: "holistic",
      style_inferred: true,
      criteria: [criterion("Overall", [level("4", 4), level("1", 1)])],
    });
    expect(inferred.rubric.style).toBe("holistic");
    expect(inferred.warnings.some((w) => w.code === "style_guess")).toBe(true);

    const guessed = normalizeRubric({
      style: "rubric",
      criteria: [
        criterion("Claim", [level("T", 1)]),
        criterion("Evidence", [level("T", 1)]),
      ],
    });
    // One level each and no declared style → single_point by shape, which
    // is unambiguous, so no warning (R-1).
    expect(guessed.rubric.style).toBe("single_point");
    expect(guessed.warnings.some((w) => w.code === "style_guess")).toBe(false);
  });

  test("R-1: an inferred analytic table with several criteria is not warned", () => {
    const { rubric, warnings } = normalizeRubric({
      style: "analytic",
      style_inferred: true,
      criteria: [
        criterion("Claim", [level("A", 2), level("B", 0)]),
        criterion("Evidence", [level("A", 2), level("B", 0)]),
      ],
    });
    expect(rubric.style).toBe("analytic");
    expect(warnings.some((w) => w.code === "style_guess")).toBe(false);
  });

  test("a declared style the shape contradicts falls back to analytic", () => {
    const { rubric, warnings } = normalizeRubric({
      style: "holistic",
      criteria: [
        criterion("Claim", [level("A", 2), level("B", 0)]),
        criterion("Evidence", [level("A", 2), level("B", 0)]),
      ],
    });
    expect(rubric.style).toBe("analytic");
    expect(warnings.some((w) => w.code === "style_guess")).toBe(true);
  });

  test("a descriptor over the schema bound is cut and warned", () => {
    const long = "x".repeat(MAX_DESCRIPTOR_CHARS + 50);
    const { rubric, warnings } = normalizeRubric({
      style: "holistic",
      criteria: [criterion("Overall", [level("4", 4, long), level("1", 1)])],
    });
    expect(rubric.criteria[0]!.levels[0]!.descriptor!.length).toBe(MAX_DESCRIPTOR_CHARS);
    expect(warnings.some((w) => w.code === "truncated_text")).toBe(true);
  });
});
