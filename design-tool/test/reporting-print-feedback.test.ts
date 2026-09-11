// Slice 5 of docs/rubric-upload-design.md (D-6): the pure selection logic
// behind the family-facing print page's Feedback block. No DB.
import { describe, expect, test } from "bun:test";
import type { Rubric } from "@secure-test/schema";
import { selectPrintFeedback } from "../lib/reporting/printFeedback";

function rubric(withFeedback: boolean | undefined): Rubric {
  return {
    style: "analytic",
    criteria: [
      {
        id: "c1",
        name: "Thesis",
        levels: [
          { id: "l1", label: "Strong", points: 4 },
          { id: "l2", label: "Weak", points: 1 },
        ],
      },
    ],
    student_visibility:
      withFeedback === undefined ? undefined : { with_feedback: withFeedback },
  };
}

const RATIONALE = {
  criterion_scores: [{ criterion_id: "c1", level_id: "l1", points: 4, rationale: "Clear claim." }],
  overall_rationale: "Strong work overall.",
};

describe("selectPrintFeedback", () => {
  test("the flag off prints nothing, even with a final rationale", () => {
    expect(selectPrintFeedback(rubric(false), RATIONALE)).toBeNull();
    expect(selectPrintFeedback(rubric(undefined), RATIONALE)).toBeNull();
  });

  test("no rubric at all prints nothing", () => {
    expect(selectPrintFeedback(null, RATIONALE)).toBeNull();
    expect(selectPrintFeedback(undefined, RATIONALE)).toBeNull();
  });

  test("the flag on but no final rationale (proposed only, or unscored) prints nothing", () => {
    expect(selectPrintFeedback(rubric(true), null)).toBeNull();
    expect(selectPrintFeedback(rubric(true), undefined)).toBeNull();
  });

  test("the flag on with a final rationale returns the rows and the overall", () => {
    const result = selectPrintFeedback(rubric(true), RATIONALE);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(1);
    expect(result!.rows[0]).toMatchObject({
      criterion_id: "c1",
      criterion_name: "Thesis",
      level_label: "Strong",
      points: 4,
      rationale: "Clear claim.",
    });
    expect(result!.overall).toBe("Strong work overall.");
  });

  test("a rationale with neither criterion rows nor an overall prints nothing", () => {
    expect(selectPrintFeedback(rubric(true), {})).toBeNull();
  });
});
