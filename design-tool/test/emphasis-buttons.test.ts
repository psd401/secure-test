import { describe, expect, test } from "bun:test";
import { appendEmphasis, applyEmphasis } from "../app/dashboard/[id]/EmphasisButtons";

// E6 follow-up (2026-09-02): the Bold / Italic buttons' pure wrap logic.
describe("applyEmphasis / appendEmphasis", () => {
  test("wraps a selection", () => {
    expect(applyEmphasis("Which is NOT an abiotic factor?", "bold", 9, 12)).toBe("Which is **NOT** an abiotic factor?");
    expect(applyEmphasis("an abiotic factor", "italic", 3, 10)).toBe("an _abiotic_ factor");
  });

  test("inserts a placeholder at a caret, and pads an italic run so it renders", () => {
    expect(applyEmphasis("Solve x", "bold", 7, 7)).toBe("Solve x**bold**");
    expect(applyEmphasis("Solve x", "italic", 7, 7)).toBe("Solve x _italic_");
    expect(applyEmphasis("Solve x here", "italic", 6, 6)).toBe("Solve _italic_ x here");
    expect(applyEmphasis("ab", "italic", 1, 1)).toBe("a _italic_ b");
  });

  test("clamps out-of-range offsets and appends when there is no caret", () => {
    expect(applyEmphasis("abc", "bold", 10, 20)).toBe("abc**bold**");
    expect(appendEmphasis("", "bold")).toBe("**bold**");
    expect(appendEmphasis("Read this", "italic")).toBe("Read this _italic_");
  });
});
