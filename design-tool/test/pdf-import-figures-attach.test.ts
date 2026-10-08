// Beta feedback 2026-10-08, slice 1: the PDF panel's figure strip says which
// figures are on a question and can put an unused one with a question.
import { describe, expect, test } from "bun:test";
import {
  attachFigure,
  figureUseLabel,
  itemRangeLabel,
  stemSnippet,
} from "../app/dashboard/[id]/pdfFigures";

const make = (index: number, figures: number[]) => ({ id: `new-${index}`, figures, item_indexes: [index] });
const SETS = [
  { id: "a", figures: [1], item_indexes: [2, 3, 4] },
  { id: "b", figures: [], item_indexes: [6] },
];

describe("itemRangeLabel / figureUseLabel", () => {
  test("one item, a block, several blocks, none", () => {
    expect(itemRangeLabel([0])).toBe("item 1");
    expect(itemRangeLabel([2, 3, 4])).toBe("items 3–5");
    expect(figureUseLabel(SETS, 1)).toBe("Used with items 3–5");
    expect(figureUseLabel([...SETS, { id: "c", figures: [1], item_indexes: [7] }], 1)).toBe(
      "Used with items 3–5, item 8",
    );
    expect(figureUseLabel(SETS, 2)).toBeNull();
  });
});

describe("attachFigure", () => {
  test("a question in a set: the figure joins that set", () => {
    const out = attachFigure(SETS, 2, 3, make);
    expect(out).toHaveLength(2);
    expect(out[0]!.figures).toEqual([1, 2]);
    expect(out[1]).toBe(SETS[1]);
  });
  test("a question in no set: a new stimulus card of one", () => {
    const out = attachFigure(SETS, 2, 0, make);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ id: "new-0", figures: [2], item_indexes: [0] });
  });
  test("already there: nothing changes; the input is not mutated", () => {
    const out = attachFigure(SETS, 1, 2, make);
    expect(out[0]!.figures).toEqual([1]);
    attachFigure(SETS, 2, 3, make);
    expect(SETS[0]!.figures).toEqual([1]);
  });
  test("one figure can go with two separate questions", () => {
    const once = attachFigure(SETS, 1, 6, make);
    expect(figureUseLabel(once, 1)).toBe("Used with items 3–5, item 7");
  });
});

describe("stemSnippet", () => {
  test("drops markup, keeps escaped dollars, cuts long stems", () => {
    expect(stemSnippet("Which **map** shows $x^2$?")).toBe("Which map shows x^2?");
    expect(stemSnippet("It costs \\$5 per [[b1]].")).toBe("It costs $5 per ___.");
    expect(stemSnippet("![Map](asset:abc) Use the map.")).toBe("Use the map.");
    expect(stemSnippet("a".repeat(80), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
