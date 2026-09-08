// R1 (docs/reporting-design.md): item analytics. Pure aggregation, so the
// p-values, the answered percentages and the distractor counts are checked
// against hand-computed numbers with no database in the way.
import { describe, expect, test } from "bun:test";
import {
  buildItemAnalytics,
  formatMean,
  type AnalyticsItem,
  type AnalyticsResponseRow,
} from "../lib/reporting/analytics";

const MC: AnalyticsItem = {
  id: "i-mc",
  position: 0,
  type: "multiple_choice_single",
  max_points: 1,
  choices: [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Bravo" },
    { id: "c", text: "Charlie" },
  ],
  correct_choice_ids: ["b"],
};

const ESSAY: AnalyticsItem = {
  id: "i-essay",
  position: 1,
  type: "essay",
  max_points: 4,
};

function mc(choice: string, points: number | null): AnalyticsResponseRow {
  return {
    item_id: MC.id,
    response: { type: "multiple_choice_single", choice_id: choice },
    points,
  };
}

function essay(points: number | null): AnalyticsResponseRow {
  return { item_id: ESSAY.id, response: { type: "essay", text: "..." }, points };
}

describe("buildItemAnalytics", () => {
  test("p-value, mean and answered % on a four-student class", () => {
    // Four handed in. On the MC, three answered (one skipped): b, b, a — two
    // of three right, so mean 2/3 = 0.667 of a 1-point item => p 67%.
    const [mcOut, essayOut] = buildItemAnalytics(
      [MC, ESSAY],
      [mc("b", 1), mc("b", 1), mc("a", 0), essay(4), essay(2), essay(3), essay(1)],
      4,
    );

    expect(mcOut!.answered_count).toBe(3);
    expect(mcOut!.answered_percent).toBe(75);
    expect(mcOut!.scored_count).toBe(3);
    expect(mcOut!.mean_points).toBeCloseTo(2 / 3, 5);
    expect(mcOut!.p_value).toBe(67);

    // Essay: all four answered, mean (4+2+3+1)/4 = 2.5 of 4 => p 63% (round).
    expect(essayOut!.answered_count).toBe(4);
    expect(essayOut!.answered_percent).toBe(100);
    expect(essayOut!.mean_points).toBe(2.5);
    expect(essayOut!.p_value).toBe(63);
    expect(essayOut!.choices).toBeNull();
  });

  test("distractor counts, with the key marked", () => {
    const [out] = buildItemAnalytics([MC], [mc("b", 1), mc("a", 0), mc("a", 0)], 3);
    expect(out!.choices).toEqual([
      { id: "a", text: "Alpha", count: 2, is_key: false },
      { id: "b", text: "Bravo", count: 1, is_key: true },
      { id: "c", text: "Charlie", count: 0, is_key: false },
    ]);
  });

  test("a multi-select response counts against every choice it names", () => {
    const multi: AnalyticsItem = {
      ...MC,
      id: "i-multi",
      type: "multiple_choice_multi",
      correct_choice_ids: ["a", "b"],
    };
    const [out] = buildItemAnalytics(
      [multi],
      [
        {
          item_id: multi.id,
          response: { type: "multiple_choice_multi", choice_ids: ["a", "c"] },
          points: 0,
        },
      ],
      1,
    );
    expect(out!.choices!.map((c) => [c.id, c.count, c.is_key])).toEqual([
      ["a", 1, true],
      ["b", 0, true],
      ["c", 1, false],
    ]);
  });

  test("a PROPOSED AI score is not a score: it counts as answered, not scored", () => {
    // points: null is what the caller passes when there is no FINAL row.
    const [out] = buildItemAnalytics([ESSAY], [essay(4), essay(null)], 2);
    expect(out!.answered_count).toBe(2);
    expect(out!.scored_count).toBe(1);
    expect(out!.unscored_count).toBe(1);
    expect(out!.mean_points).toBe(4);
    expect(out!.p_value).toBe(100);
  });

  test("an item nobody answered reports zeroes and no mean", () => {
    const [out] = buildItemAnalytics([ESSAY], [], 3);
    expect(out!.answered_count).toBe(0);
    expect(out!.answered_percent).toBe(0);
    expect(out!.mean_points).toBeNull();
    expect(out!.p_value).toBeNull();
  });

  test("no submitted attempts at all: percentages are null, not a divide by zero", () => {
    const [out] = buildItemAnalytics([MC], [], 0);
    expect(out!.answered_percent).toBeNull();
    expect(out!.p_value).toBeNull();
    expect(out!.choices!.every((c) => c.count === 0)).toBe(true);
  });

  test("rows for an item that is not in the list are ignored", () => {
    const [out] = buildItemAnalytics([ESSAY], [mc("b", 1), essay(2)], 1);
    expect(out!.answered_count).toBe(1);
    expect(out!.mean_points).toBe(2);
  });
});

describe("formatMean", () => {
  test("integers stay whole, fractions get one decimal, null is a dash", () => {
    expect(formatMean(2)).toBe("2");
    expect(formatMean(2.5)).toBe("2.5");
    expect(formatMean(2 / 3)).toBe("0.7");
    expect(formatMean(null)).toBe("—");
  });
});
