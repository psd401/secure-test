// Slice 4 of docs/rubric-upload-design.md (D-5 / D-6): the pure reading of
// a score row's rationale shared by the queue card, the per-student results
// page and — slice 5 — the family-facing print page. No DB.
import { describe, expect, test } from "bun:test";
import type { Rubric } from "@secure-test/schema";
import {
  overallRationale,
  rubricScoreRows,
} from "../lib/reporting/rubricScoreView";

const ANALYTIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "ideas",
      name: "Ideas",
      levels: [
        { id: "i1", label: "Emerging", points: 1 },
        { id: "i2", label: "Proficient", points: 2 },
      ],
    },
  ],
};

const SINGLE_POINT: Rubric = {
  style: "single_point",
  criteria: [
    { id: "focus", name: "Focus", levels: [{ id: "t", label: "Target", points: 2 }] },
    { id: "evidence", name: "Evidence", levels: [{ id: "t2", label: "Target", points: 1 }] },
  ],
};

describe("rubricScoreRows", () => {
  test("names the criterion and the chosen level for an analytic rubric", () => {
    const rows = rubricScoreRows(ANALYTIC, {
      criterion_scores: [
        { criterion_id: "ideas", level_id: "i2", points: 2, rationale: "Clear thesis." },
      ],
      overall_rationale: "Strong.",
    });
    expect(rows).toEqual([
      {
        criterion_id: "ideas",
        criterion_name: "Ideas",
        level_label: "Proficient",
        points: 2,
        rationale: "Clear thesis.",
      },
    ]);
  });

  test("a single-point selection reads Below / Meets / Exceeds target", () => {
    const rows = rubricScoreRows(SINGLE_POINT, {
      criterion_scores: [
        { criterion_id: "focus", level_id: "t.meets", points: 2, rationale: "one claim" },
        { criterion_id: "evidence", level_id: "t2.below", points: 0, rationale: "" },
      ],
    });
    expect(rows.map((r) => [r.criterion_name, r.level_label, r.points])).toEqual([
      ["Focus", "Meets target", 2],
      ["Evidence", "Below target", 0],
    ]);
    // An empty per-criterion rationale is "nothing said", not "".
    expect(rows[1]!.rationale).toBeNull();
  });

  test("an unresolvable id falls back to what was stored, never throws", () => {
    const rows = rubricScoreRows(ANALYTIC, {
      criterion_scores: [
        { criterion_id: "gone", level_id: "x9", points: 1, rationale: "r" },
      ],
    });
    expect(rows).toEqual([
      {
        criterion_id: "gone",
        criterion_name: "gone",
        level_label: "x9",
        points: 1,
        rationale: "r",
      },
    ]);
  });

  test("no rubric, no criterion_scores, or junk gives no rows", () => {
    expect(rubricScoreRows(null, { overall_rationale: "bare points" })).toEqual([]);
    expect(rubricScoreRows(ANALYTIC, null)).toEqual([]);
    expect(rubricScoreRows(ANALYTIC, { criterion_scores: "nope" })).toEqual([]);
    expect(rubricScoreRows(ANALYTIC, { criterion_scores: [{ level_id: "i2" }] })).toEqual(
      [],
    );
  });
});

describe("overallRationale", () => {
  test("returns the text, or null for blank and missing", () => {
    expect(overallRationale({ overall_rationale: "Solid work." })).toBe("Solid work.");
    expect(overallRationale({ overall_rationale: "   " })).toBeNull();
    expect(overallRationale({ note: "x" })).toBeNull();
    expect(overallRationale(null)).toBeNull();
  });
});
