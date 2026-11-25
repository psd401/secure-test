// B1 point weighting, slice 1 (docs/point-weighting-design.md): the pure
// rules — the weight step, the item maximum, the manual-entry maximum, the
// rubric scaling, the D5 field, and the AI-vs-human comparison scale.
import { describe, expect, test } from "bun:test";
import type { ItemRow } from "../db/schema";
import type { Rubric } from "@secure-test/schema";
import { applyWeight } from "../lib/scoring/weight";
import { scoreResponse } from "../lib/scoring/auto";
import {
  entryMaxPoints,
  itemMaxPoints,
  naturalMaxPoints,
  scaleEntry,
} from "../lib/scoring/results";
import { PointsField } from "../lib/api/items";
import { checkManualScore } from "../lib/api/reviewActions";
import { compareRun, type ComparisonPair } from "../lib/reporting/runComparison";

function fakeItem(partial: Partial<ItemRow> & { type: string }): ItemRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    assessment_id: "00000000-0000-0000-0000-000000000002",
    item_set_id: null,
    position: 0,
    stem: "stem",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    config: {},
    standards: [],
    points: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...partial,
  } as ItemRow;
}

// 4 + 4 = an 8-point analytic rubric.
const RUBRIC: Rubric = {
  style: "analytic",
  criteria: ["a", "b"].map((id) => ({
    id,
    name: id,
    levels: [1, 2, 3, 4].map((p) => ({ id: `${id}${p}`, label: `L${p}`, points: p })),
  })),
} as Rubric;

const mc = (points: number | null) =>
  fakeItem({
    type: "multiple_choice_single",
    choices: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
    correct_choice_ids: ["b"],
    points,
  });

// Three keyed cells.
const table = (points: number | null) =>
  fakeItem({
    type: "table",
    config: {
      columns: [{ id: "c1", label: "C" }],
      rows: [
        { id: "r1", label: "1" },
        { id: "r2", label: "2" },
        { id: "r3", label: "3" },
      ],
      cell_keys: { r1: { c1: "x" }, r2: { c1: "y" }, r3: { c1: "z" } },
    } as ItemRow["config"],
    points,
  });

const cells = (r1: string, r2: string, r3: string) => ({
  type: "table" as const,
  cells: { r1: { c1: r1 }, r2: { c1: r2 }, r3: { c1: r3 } },
});

describe("applyWeight", () => {
  test("no weight leaves the natural score alone", () => {
    expect(applyWeight(2, 3, null)).toEqual({ points: 2, max_points: 3 });
    expect(applyWeight(2, 3, undefined)).toEqual({ points: 2, max_points: 3 });
  });
  test("full credit is exactly the weight", () => {
    expect(applyWeight(3, 3, 7.5)).toEqual({ points: 7.5, max_points: 7.5 });
  });
  test("partial credit is proportional, rounded to 2 decimals", () => {
    expect(applyWeight(1, 3, 1)).toEqual({ points: 0.33, max_points: 1 });
    expect(applyWeight(2, 3, 1)).toEqual({ points: 0.67, max_points: 1 });
    expect(applyWeight(1, 4, 6)).toEqual({ points: 1.5, max_points: 6 });
    expect(applyWeight(0, 4, 6)).toEqual({ points: 0, max_points: 6 });
  });
  test("a natural max of 0 is left alone (no divide by zero)", () => {
    expect(applyWeight(0, 0, 5)).toEqual({ points: 0, max_points: 0 });
  });
});

describe("scoreResponse with a weight", () => {
  test("NULL points = today's numbers", () => {
    expect(scoreResponse(mc(null), { type: "multiple_choice_single", choice_id: "b" })).toEqual({
      points: 1,
      max_points: 1,
    });
    expect(scoreResponse(table(null), cells("x", "no", "no"))).toEqual({ points: 1, max_points: 3 });
  });
  test("all-or-nothing types score 0 or the weight", () => {
    for (const w of [1, 4, 6]) {
      expect(scoreResponse(mc(w), { type: "multiple_choice_single", choice_id: "b" })).toEqual({
        points: w,
        max_points: w,
      });
      expect(scoreResponse(mc(w), { type: "multiple_choice_single", choice_id: "a" })).toEqual({
        points: 0,
        max_points: w,
      });
    }
  });
  test("a table splits its weight across keyed cells", () => {
    expect(scoreResponse(table(6), cells("x", "y", "no"))).toEqual({ points: 4, max_points: 6 });
    expect(scoreResponse(table(1), cells("x", "no", "no"))).toEqual({ points: 0.33, max_points: 1 });
    expect(scoreResponse(table(4), cells("x", "y", "z"))).toEqual({ points: 4, max_points: 4 });
  });
  test("a keyless item is still unscorable", () => {
    expect(
      scoreResponse({ ...mc(5), correct_choice_ids: [] }, { type: "multiple_choice_single", choice_id: "b" }),
    ).toBeNull();
  });
});

describe("item maximum", () => {
  test("itemMaxPoints is the weight, else the natural max", () => {
    expect(itemMaxPoints(table(null))).toBe(3);
    expect(itemMaxPoints(table(6))).toBe(6);
    expect(naturalMaxPoints(table(6))).toBe(3);
    // A caller without the column (an ItemView) gets the natural max.
    expect(itemMaxPoints({ type: "table", config: table(null).config })).toBe(3);
  });
  test("a rubric item: worth its weight, entered in rubric points", () => {
    const essay = fakeItem({ type: "essay", config: { rubric: RUBRIC }, points: 4 });
    expect(itemMaxPoints(essay)).toBe(4);
    expect(entryMaxPoints(essay)).toBe(8);
    expect(scaleEntry(essay, 6, 8)).toEqual({ points: 3, max_points: 4 });
    expect(scaleEntry(essay, 8, 8)).toEqual({ points: 4, max_points: 4 });
  });
  test("a non-rubric item is entered on its weight and stored as entered", () => {
    expect(entryMaxPoints(table(6))).toBe(6);
    expect(scaleEntry(table(6), 4.5, 6)).toEqual({ points: 4.5, max_points: 6 });
  });
});

describe("checkManualScore uses the entry maximum", () => {
  test("a weighted table expects its weight", () => {
    const ok = checkManualScore(table(6), { points: 3, max_points: 6 });
    expect(ok.ok).toBe(true);
    const bad = checkManualScore(table(6), { points: 2, max_points: 3 });
    expect(bad).toMatchObject({ ok: false, body: { error: "max_points_mismatch", expected: 6 } });
  });
  test("a weighted rubric item expects the rubric max", () => {
    const essay = fakeItem({ type: "essay", config: { rubric: RUBRIC }, points: 4 });
    expect(checkManualScore(essay, { points: 6, max_points: 8 }).ok).toBe(true);
    expect(checkManualScore(essay, { points: 3, max_points: 4 }).ok).toBe(false);
  });
});

describe("PointsField (D5)", () => {
  test("accepts >0, <=100, up to 2 decimals", () => {
    for (const n of [0.01, 0.29, 1, 1.5, 2.25, 100]) expect(PointsField.safeParse(n).success).toBe(true);
  });
  test("refuses 0, negatives, >100 and a third decimal", () => {
    for (const n of [0, -1, 100.01, 0.295, 1.001]) expect(PointsField.safeParse(n).success).toBe(false);
  });
});

describe("compareRun on a weighted rubric item", () => {
  test("the human final is put back on the rubric scale", () => {
    // Research row in rubric points (6 / 8); the human final on a 4-point
    // weight (3 / 4) is the same score, so it must count as exact agreement.
    const pairs: ComparisonPair[] = [
      {
        response_id: "r1",
        item_id: "i1",
        research: { points: 6, max_points: 8, rationale: {} },
        human: { points: 3, max_points: 4, rationale: {} },
      },
    ];
    const c = compareRun({ label: "A", provider_id: "mock", prompt_version: "v", pairs });
    expect(c.mean_abs_points_diff).toBe(0);
  });
});
