import { describe, expect, test } from "bun:test";
import { needsAnswerKey, questionGaps, readinessChecks, stimulusGaps, type ReadinessItem } from "../app/dashboard/[id]/readiness";

function item(over: Partial<ReadinessItem>): ReadinessItem {
  return {
    type: "multiple_choice_single",
    stem: "What is 7 + 5?",
    choices: [
      { id: "a", text: "11" },
      { id: "b", text: "12" },
    ],
    correct_choice_ids: ["b"],
    correct_answer: null,
    pairs: null,
    sequence: null,
    image_asset_id: null,
    correct_region_ids: null,
    ...over,
  };
}

describe("questionGaps (UX pass 1 slice 4 publish checklist)", () => {
  test("a complete multiple-choice question has no gaps", () => {
    expect(questionGaps(item({}))).toEqual([]);
  });
  test("blank text, empty choice and no correct answer are each named", () => {
    expect(
      questionGaps(item({ stem: "  ", choices: [{ id: "a", text: "" }, { id: "b", text: "x" }], correct_choice_ids: [] })),
    ).toEqual(["needs question text", "has an empty choice", "needs a correct answer"]);
  });
  test("seeded placeholder text counts as not written yet (A-08)", () => {
    expect(questionGaps(item({ stem: "New question", choices: [{ id: "a", text: "Choice A" }, { id: "b", text: "Choice B" }], correct_choice_ids: ["a"] }))).toEqual([
      "still has the placeholder text",
      "still has placeholder choices",
    ]);
    expect(questionGaps(item({ type: "short_text", stem: "Real question", correct_answer: "answer" }))).toEqual([
      "still has the placeholder answer",
    ]);
  });
  test("short text needs an answer; essay and drawing need only text", () => {
    expect(questionGaps(item({ type: "short_text", correct_answer: "" }))).toEqual(["needs a correct answer"]);
    expect(questionGaps(item({ type: "essay", choices: [], correct_choice_ids: [] }))).toEqual([]);
    expect(questionGaps(item({ type: "drawing_upload", choices: [], correct_choice_ids: [] }))).toEqual([]);
  });
  test("match and order need two filled entries; hotspot needs an image and a region", () => {
    expect(questionGaps(item({ type: "match", pairs: [{ left: "a", right: "b" }] }))).toEqual(["needs at least 2 pairs"]);
    expect(questionGaps(item({ type: "match", pairs: [{ left: "a", right: "" }, { left: "c", right: "d" }] }))).toEqual(["has an empty pair"]);
    expect(questionGaps(item({ type: "order", sequence: [{ label: "one" }] }))).toEqual(["needs at least 2 steps"]);
    expect(questionGaps(item({ type: "hotspot", image_asset_id: null, correct_region_ids: [] }))).toEqual([
      "needs an image",
      "needs a correct region",
    ]);
  });
});

describe("readinessChecks", () => {
  test("no questions is the first failing line", () => {
    expect(readinessChecks([])).toEqual([
      { label: "No questions yet", ok: false },
      { label: "Every question has its text and answer", ok: false },
    ]);
  });
  test("names each incomplete question by number, capped at five", () => {
    const bad = item({ stem: "" });
    const checks = readinessChecks([item({}), bad, bad, bad, bad, bad, bad]);
    expect(checks[0]).toEqual({ label: "7 questions", ok: true });
    expect(checks[1]).toEqual({ label: "Question 2 needs question text", ok: false });
    expect(checks.at(-1)).toEqual({ label: "…and 1 more", ok: false });
    expect(checks).toHaveLength(7);
  });
  test("all complete reads as ready", () => {
    expect(readinessChecks([item({})])).toEqual([
      { label: "1 question", ok: true },
      { label: "Every question has its text and answer", ok: true },
    ]);
  });
});

describe("needsAnswerKey", () => {
  test("MC with no correct choice needs a key", () => {
    expect(needsAnswerKey({ type: "multiple_choice_single", correct_choice_ids: [] })).toBe(true);
    expect(needsAnswerKey({ type: "multiple_choice_multi", correct_choice_ids: [] })).toBe(true);
    expect(needsAnswerKey({ type: "multiple_choice_single", correct_choice_ids: ["b"] })).toBe(false);
  });
  test("short_text with a blank answer needs a key", () => {
    expect(needsAnswerKey({ type: "short_text", correct_answer: "" })).toBe(true);
    expect(needsAnswerKey({ type: "short_text", correct_answer: "   " })).toBe(true);
    expect(needsAnswerKey({ type: "short_text", correct_answer: null })).toBe(true);
    expect(needsAnswerKey({ type: "short_text", correct_answer: "Olympia" })).toBe(false);
  });
  test("types without an objective key never need one", () => {
    expect(needsAnswerKey({ type: "essay" })).toBe(false);
    expect(needsAnswerKey({ type: "drawing_upload" })).toBe(false);
  });
});

// E5 slice 1: an empty stimulus is a readiness gap, named by its first question.
describe("stimulusGaps (E5 slice 1)", () => {
  const essay = (stem: string, item_set_id: string | null): ReadinessItem => ({
    type: "essay", stem, choices: [], correct_choice_ids: [], correct_answer: null,
    pairs: null, sequence: null, image_asset_id: null, correct_region_ids: null, item_set_id,
  });
  test("names the first question of each empty-stimulus set; filled sets are fine", () => {
    const items = [essay("A", null), essay("B", "s1"), essay("C", "s1"), essay("D", "s2")];
    expect(stimulusGaps(items, [{ id: "s1", stimulus_text: "  " }, { id: "s2", stimulus_text: "Figure 1" }]))
      .toEqual(["Stimulus for question 2 is empty"]);
    const checks = readinessChecks(items, [{ id: "s1", stimulus_text: "" }]);
    expect(checks.at(-1)).toEqual({ label: "Stimulus for question 2 is empty", ok: false });
    expect(readinessChecks(items).every((c) => c.ok)).toBe(true);
  });
});

// E12 slice 2: a source-backed stimulus may have an empty lead-in; a draft
// source warns (decision D-2), never blocks.
describe("stimulusGaps — source-backed sets (E12)", () => {
  const items: ReadinessItem[] = [
    { type: "essay", stem: "Write", item_set_id: "s1", choices: [], correct_choice_ids: [], correct_answer: null, pairs: null, sequence: null, image_asset_id: null, correct_region_ids: null },
  ];
  test("no empty gap when a source is set; a draft source warns by name", () => {
    expect(stimulusGaps(items, [{ id: "s1", stimulus_text: "", source: { assessment_name: "Outline", assessment_status: "published" } }])).toEqual([]);
    expect(stimulusGaps(items, [{ id: "s1", stimulus_text: "", source: { assessment_name: "Outline", assessment_status: "draft" } }])).toEqual([
      'Stimulus for question 1 pulls from "Outline", which is not published',
    ]);
    expect(stimulusGaps(items, [{ id: "s1", stimulus_text: "", source: null }])).toEqual(["Stimulus for question 1 is empty"]);
  });
});

// E3 slice 2: a table needs a grid with headings; keys are optional.
describe("questionGaps: table (E3)", () => {
  const grid = {
    type: "table" as const,
    stem: "Fill in the table",
    choices: [],
    correct_choice_ids: [],
    columns: [{ label: "Observed" }, { label: "Expected" }],
    rows: [{ label: "" }, { label: "Total" }],
  };
  test("a complete keyless table has no gaps", () => {
    expect(questionGaps(item(grid))).toEqual([]);
  });
  test("an empty grid, an empty heading, and seeded headings are each named", () => {
    expect(questionGaps(item({ ...grid, columns: [] }))).toEqual(["needs at least one column and one row"]);
    expect(questionGaps(item({ ...grid, rows: [] }))).toEqual(["needs at least one column and one row"]);
    expect(questionGaps(item({ ...grid, columns: [{ label: "A" }, { label: " " }] }))).toEqual(["has an empty column heading"]);
    expect(questionGaps(item({ ...grid, stem: "New table", columns: [{ label: "Column A" }, { label: "Column B" }] }))).toEqual([
      "still has the placeholder text",
      "still has placeholder headings",
    ]);
    expect(questionGaps(item({ ...grid, rows: [{ label: "Row 1" }] }))).toEqual(["still has placeholder headings"]);
  });
});
