// PDF-import slice 3b (2026-10-25): the scorer that judges an import against
// a hand-checked answer set. Fixtures are made up; the real answer set
// describes teacher documents and is never committed.
import { describe, expect, test } from "bun:test";
import { scoreImport, type ExpectedImport, type ObservedImport } from "../scripts/pdfImportScore";

const expected: ExpectedImport = {
  total_items: [4, 5],
  numbers: {
    "1": { items: [1, 1], types: ["multiple_choice_single"], figures: [1] },
    "2": { items: [2, 3], types: ["short_text", "fill_blank"], figures: [2, 3] },
    "3": { items: [1, 1], types: ["drawing_upload"], figures: [] },
  },
  key_figures: [4],
  keys_required: { answers: ["12.5 m"] },
};

const good: ObservedImport = {
  items: [
    { type: "multiple_choice_single", numbers: [1] },
    { type: "short_text", numbers: [2], correct_answer: "12.5 m" },
    { type: "fill_blank", numbers: [2] },
    { type: "drawing_upload", numbers: [3] },
  ],
  sets: [
    { figures: [1], item_indexes: [0] },
    { figures: [2, 3], item_indexes: [1, 2] },
  ],
  key_figures: [4],
  forms: null,
};

const failing = (obs: ObservedImport) => scoreImport(expected, obs).filter((c) => !c.pass).map((c) => c.name);

describe("scoreImport", () => {
  test("a right proposal passes every check", () => {
    expect(failing(good)).toEqual([]);
  });

  test("a dropped sub-part fails the count and the total", () => {
    expect(failing({ ...good, items: good.items.filter((_, i) => i !== 2), sets: [good.sets[0]!, { figures: [2, 3], item_indexes: [1] }] }))
      .toEqual(["total items", "#2 item count"]);
  });

  test("a figure on the wrong question fails both questions' figure checks", () => {
    const sets = [{ figures: [1], item_indexes: [0] }, { figures: [2], item_indexes: [1, 2] }, { figures: [3], item_indexes: [3] }];
    expect(failing({ ...good, sets })).toEqual(["#2 figures", "#3 figures"]);
  });

  test("an answer-key drawing shown to students, or not flagged, fails", () => {
    expect(failing({ ...good, key_figures: [] })).toEqual(["key figure 4 flagged"]);
    expect(failing({ ...good, sets: [...good.sets, { figures: [4], item_indexes: [3] }] }))
      .toEqual(["#3 figures", "figure 4 not shown to students"]);
  });

  test("a wrong type and a missing key fail", () => {
    const items = good.items.map((it, i) => (i === 3 ? { ...it, type: "essay" } : i === 1 ? { ...it, correct_answer: null } : it));
    expect(failing({ ...good, items })).toEqual(["#3 types", 'key "12.5 m"']);
  });

  test("forms compare the count and the questions per form", () => {
    const withForms: ExpectedImport = { total_items: [0, 99], forms: { count: 2, sizes: [2, 2] } };
    expect(scoreImport(withForms, { ...good, forms: { sizes: [2, 2] } }).every((c) => c.pass)).toBe(true);
    expect(scoreImport(withForms, { ...good, forms: { sizes: [2, 2, 2] } }).some((c) => !c.pass)).toBe(true);
    expect(scoreImport(withForms, { ...good, forms: null }).some((c) => !c.pass)).toBe(true);
  });
});
