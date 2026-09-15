// Numeric equivalence (James, 2026-09-15; docs/math-entry-design.md
// §Follow-ups "Numeric equivalence"). Short-text auto-scoring compared folded
// STRINGS, so a key of `1/2` failed a student's `0.5`. When both sides parse
// as a number they are now compared by VALUE, with a per-item `exact_form`
// opt-out for tasks where the form is the answer ("in lowest terms").
//
// Every row here is a pure function call — no DB, so this file runs without
// DATABASE_URL, like scoring-math-fold.test.ts beside it.
import { describe, expect, test } from "bun:test";
import type { ItemRow } from "../db/schema";
import {
  numbersClose,
  numericAnswersEqual,
  parseNumericAnswer,
  scoreResponse,
  shortTextMatches,
  tableCellMatches,
} from "../lib/scoring/auto";

describe("parseNumericAnswer — the shapes a student types as a number", () => {
  test.each([
    // [input, value]
    ["7", 7],
    ["0.50", 0.5],
    [".5", 0.5],
    ["-3", -3],
    ["+3", 3],
    ["1,000", 1000],
    ["1,234,567", 1234567],
    ["1/2", 0.5],
    ["2/4", 0.5],
    ["50/100", 0.5],
    ["-1/2", -0.5],
    ["1 1/2", 1.5],
    ["2 3/4", 2.75],
    ["3.2e5", 320000],
    ["3.2 x 10^5", 320000],
    ["3.2 × 10^5", 320000],
    ["3.2×10^{5}", 320000],
    ["1 × 10^{-4}", 0.0001],
    ["\\frac{1}{2}", 0.5],
    ["$\\frac{1}{2}$", 0.5],
  ] as const)("%s → %p", (input, value) => {
    const parsed = parseNumericAnswer(input);
    expect(parsed).not.toBeNull();
    expect(numbersClose(parsed!.value, value)).toBe(true);
    expect(parsed!.percent).toBe(false);
  });

  test("a trailing % is recorded and divided out", () => {
    expect(parseNumericAnswer("50%")).toEqual({ value: 0.5, percent: true });
    expect(parseNumericAnswer("12.5 %")).toEqual({ value: 0.125, percent: true });
  });

  test.each([
    // Anything the parser does not fully understand yields null, and the
    // caller falls back to the folded string comparison unchanged.
    ["a unit", "5 cm"],
    ["a word", "one half"],
    ["a root", "√2"],
    ["a Greek letter", "π"],
    ["an expression", "2×3"],
    ["a bare power of ten", "10^4"],
    ["a variable", "x"],
    ["money keeps its $", "$57,600"],
    ["a malformed thousands group", "1,23"],
    ["a zero denominator", "1/0"],
    ["nothing", ""],
  ] as const)("%s does not parse (%s)", (_label, input) => {
    expect(parseNumericAnswer(input)).toBeNull();
  });
});

describe("shortTextMatches — equivalent numeric forms score", () => {
  test.each([
    // [label, student answer, teacher key]
    ["a decimal for a fraction key", "0.5", "1/2"],
    ["an unreduced fraction", "2/4", "1/2"],
    ["50/100", "50/100", "1/2"],
    ["trailing zeros", "0.50", "0.5"],
    ["a mixed number for a decimal key", "1 1/2", "1.5"],
    ["a mixed number for an improper fraction", "1 1/2", "3/2"],
    ["scientific for a plain number", "3.2 x 10^5", "320000"],
    ["e-notation for the keypad's ×10^", "3.2e5", "3.2 × 10^{5}"],
    ["a thousands separator", "1,000", "1000"],
    ["a negative", "-0.25", "-1/4"],
    ["both sides a percentage", "50%", "50.0%"],
    ["a repeating fraction within tolerance", "1/3", "0.3333333333333333"],
    ["the rule is symmetric — a teacher may key the decimal", "1/2", "0.5"],
  ] as const)("%s", (_label, response, key) => {
    expect(shortTextMatches(response, key)).toBe(true);
  });

  test.each([
    ["different values", "0.6", "1/2"],
    ["a percentage is not its decimal (both sides or neither)", "50%", "0.5"],
    ["a decimal is not a percentage", "0.5", "50%"],
    ["a unit still falls through to the fold", "5 cm", "5"],
    ["prose is untouched", "cellwall", "cell wall"],
    ["the recorded limit 104 ≠ 10^4 still holds", "104", "10^4"],
    ["no arithmetic: 2×3 is not 6", "2×3", "6"],
  ] as const)("%s does NOT match", (_label, response, key) => {
    expect(shortTextMatches(response, key)).toBe(false);
  });

  test("exact_form restores the pre-2026-09-15 comparison", () => {
    expect(shortTextMatches("0.5", "1/2", { exactForm: true })).toBe(false);
    expect(shortTextMatches("2/4", "1/2", { exactForm: true })).toBe(false);
    // Exact form is not exact BYTES: the plain + fold rules are unchanged, so
    // notation still equates and whitespace/case still normalize.
    expect(shortTextMatches("\\frac{1}{2}", "1/2", { exactForm: true })).toBe(true);
    expect(shortTextMatches("1/2", "1/2", { exactForm: true })).toBe(true);
    expect(shortTextMatches("cell wall", "cell   WALL", { exactForm: true })).toBe(true);
  });
});

describe("numbersClose — the tolerance", () => {
  test("relative 1e-9 apart is equal, 1e-6 apart is not", () => {
    expect(numbersClose(1000, 1000 + 1e-7)).toBe(true);
    expect(numbersClose(1000, 1000.001)).toBe(false);
    expect(numbersClose(1 / 3, 0.333333333333333)).toBe(true);
    expect(numbersClose(1 / 3, 0.333)).toBe(false);
  });

  test("an absolute floor near zero", () => {
    expect(numbersClose(0, 1e-13)).toBe(true);
    expect(numbersClose(0, 1e-6)).toBe(false);
  });

  test("numericAnswersEqual needs both sides numeric", () => {
    expect(numericAnswersEqual("0.5", "1/2")).toBe(true);
    expect(numericAnswersEqual("0.5", "half")).toBe(false);
    expect(numericAnswersEqual("half", "0.5")).toBe(false);
  });
});

function fakeItem(partial: Partial<ItemRow> & { type: string }): ItemRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    assessment_id: "00000000-0000-0000-0000-000000000002",
    position: 0,
    stem: "stem",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    config: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...partial,
  } as ItemRow;
}

describe("scoreResponse — the item's exact_form switch", () => {
  test.each([["0.5"], ["2/4"], ["0.50"]])("key 1/2 scores %s", (text) => {
    const item = fakeItem({ type: "short_text", correct_answer: "1/2" });
    expect(scoreResponse(item, { type: "short_text", text })).toEqual({
      points: 1,
      max_points: 1,
    });
  });

  test("50% against a key of 0.5 is incorrect", () => {
    const item = fakeItem({ type: "short_text", correct_answer: "0.5" });
    expect(scoreResponse(item, { type: "short_text", text: "50%" })).toEqual({
      points: 0,
      max_points: 1,
    });
  });

  test("exact_form: true marks 0.5 wrong for a key of 1/2", () => {
    const item = fakeItem({
      type: "short_text",
      correct_answer: "1/2",
      config: { exact_form: true },
    });
    expect(scoreResponse(item, { type: "short_text", text: "0.5" })).toEqual({
      points: 0,
      max_points: 1,
    });
    expect(scoreResponse(item, { type: "short_text", text: "1/2" })).toEqual({
      points: 1,
      max_points: 1,
    });
  });

  test("exact_form: false is the default and behaves as absent", () => {
    const item = fakeItem({
      type: "short_text",
      correct_answer: "1/2",
      config: { exact_form: false },
    });
    expect(scoreResponse(item, { type: "short_text", text: "0.5" })).toEqual({
      points: 1,
      max_points: 1,
    });
  });
});

describe("table cells inherit the same rule (E3 D-3 unchanged)", () => {
  test("decimals still compare as numbers", () => {
    expect(tableCellMatches("1.50", "1.5")).toBe(true);
    expect(tableCellMatches("2", "3")).toBe(false);
  });
  test("a fraction now meets a decimal key, like every other answer", () => {
    expect(tableCellMatches("1/2", "0.5")).toBe(true);
  });
  test("non-numeric cells still fold", () => {
    expect(tableCellMatches("h₂o", "H2O")).toBe(true);
    expect(tableCellMatches("104", "10^4")).toBe(false);
  });
});
