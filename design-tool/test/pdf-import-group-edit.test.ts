// Page groups in the import review (2026-10-28): lib/pdfImport/groupEdit.ts.
import { describe, expect, test } from "bun:test";
import { isProposedPageGroup, prependToSet, splitProposedGroup } from "../lib/pdfImport/groupEdit";

const group = { id: "g", stimulus: "", figures: [] as number[], item_indexes: [2, 3, 4, 5], sources: [] as unknown[] };

describe("isProposedPageGroup", () => {
  test("empty with two or more questions; a figure, text, source or one question is a stimulus", () => {
    expect(isProposedPageGroup(group)).toBe(true);
    expect(isProposedPageGroup({ ...group, figures: [1] })).toBe(false);
    expect(isProposedPageGroup({ ...group, needs_figure: true })).toBe(false);
    expect(isProposedPageGroup({ ...group, stimulus: "Read." })).toBe(false);
    expect(isProposedPageGroup({ ...group, sources: [{ label: "A", text: "x" }] })).toBe(false);
    expect(isProposedPageGroup({ ...group, item_indexes: [2] })).toBe(false);
  });
});

describe("splitProposedGroup", () => {
  test("in the middle: two groups", () => {
    expect(splitProposedGroup(group, 4, "t")).toEqual([
      { ...group, item_indexes: [2, 3] },
      { ...group, id: "t", item_indexes: [4, 5] },
    ]);
  });
  test("a half of one comes out of any group; the first question changes nothing", () => {
    expect(splitProposedGroup(group, 5, "t")).toEqual([{ ...group, item_indexes: [2, 3, 4] }]);
    expect(splitProposedGroup(group, 3, "t")).toEqual([{ ...group, id: "t", item_indexes: [3, 4, 5] }]);
    expect(splitProposedGroup({ ...group, item_indexes: [2, 3] }, 3, "t")).toEqual([]);
    expect(splitProposedGroup(group, 2, "t")).toEqual([group]);
  });
});

describe("prependToSet", () => {
  test("only the question just above joins", () => {
    expect(prependToSet(group, 1).item_indexes).toEqual([1, 2, 3, 4, 5]);
    expect(prependToSet(group, 0)).toBe(group);
  });
});
