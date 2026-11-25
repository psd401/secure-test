// B1 (docs/point-weighting-design.md, D1): the line that joins a weighted
// rubric question's score (on the question's points) to its criterion rows
// (on the rubric's own scale).
import { describe, expect, test } from "bun:test";
import type { Rubric } from "@secure-test/schema";
import { rubricScaleLine } from "../lib/reporting/rubricScoreView";
import { selectPrintFeedback } from "../lib/reporting/printFeedback";

// 4 + 4 = an 8-point analytic rubric, shown to families with feedback.
const RUBRIC = {
  style: "analytic",
  student_visibility: { during: false, with_feedback: true },
  criteria: ["a", "b"].map((id) => ({
    id,
    name: id === "a" ? "Ideas" : "Organization",
    levels: [1, 2, 3, 4].map((p) => ({ id: `${id}${p}`, label: `L${p}`, points: p })),
  })),
} as Rubric;

const picks = (a: number, b: number) => ({
  criterion_scores: [
    { criterion_id: "a", level_id: `a${a}`, points: a, rationale: "" },
    { criterion_id: "b", level_id: `b${b}`, points: b, rationale: "" },
  ],
});

describe("rubricScaleLine", () => {
  test("a weighted rubric question names both scales", () => {
    expect(rubricScaleLine(RUBRIC, { points: 3, max_points: 4 }, picks(4, 2))).toBe(
      "Rubric 6 of 8, scaled to 3 of 4 points",
    );
    expect(rubricScaleLine(RUBRIC, { points: 10, max_points: 10 }, picks(4, 4))).toBe(
      "Rubric 8 of 8, scaled to 10 of 10 points",
    );
  });

  test("null on the rubric's own scale (every unweighted question)", () => {
    expect(rubricScaleLine(RUBRIC, { points: 6, max_points: 8 }, picks(4, 2))).toBeNull();
  });

  test("null without a rubric or a score", () => {
    expect(rubricScaleLine(null, { points: 3, max_points: 4 }, picks(4, 2))).toBeNull();
    expect(rubricScaleLine(RUBRIC, null, picks(4, 2))).toBeNull();
  });

  test("a bare-points score is put back on the rubric scale from its share", () => {
    expect(rubricScaleLine(RUBRIC, { points: 1.5, max_points: 4 }, { note: "holistic" })).toBe(
      "Rubric 3 of 8, scaled to 1.5 of 4 points",
    );
    // 1 of 3 on an 8-point rubric rounds to 2 decimals.
    expect(rubricScaleLine(RUBRIC, { points: 1, max_points: 3 }, {})).toBe(
      "Rubric 2.67 of 8, scaled to 1 of 3 points",
    );
  });
});

describe("the family print page carries the line", () => {
  test("weighted: scale set; unweighted or no score given: null", () => {
    expect(selectPrintFeedback(RUBRIC, picks(4, 2), { points: 3, max_points: 4 })?.scale).toBe(
      "Rubric 6 of 8, scaled to 3 of 4 points",
    );
    expect(selectPrintFeedback(RUBRIC, picks(4, 2), { points: 6, max_points: 8 })?.scale).toBeNull();
    expect(selectPrintFeedback(RUBRIC, picks(4, 2))?.scale).toBeNull();
  });
});
