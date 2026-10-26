// R-7 (docs/editor-redesign-design.md, Phase 4 slice C): the new editor's
// matching re-pair (a swap of two rows' rights) and ordering step moves, and
// what the live region says after each.

import { describe, expect, test } from "bun:test";
import type { MatchPair } from "@secure-test/schema";
import { keyExcerpt, matchSwapAnnouncement, stepMoveAnnouncement, swapMatchRights } from "@/lib/authoring/keyOrder";
import { moveInList } from "@/lib/authoring/outline";

const pairs: MatchPair[] = [
  { id: "p1", left: "France", right: "Rome" },
  { id: "p2", left: "Italy", right: "Paris" },
  { id: "p3", left: "Spain", right: "Madrid" },
];

describe("swapMatchRights", () => {
  test("swaps only the two rows' rights; ids, lefts and other rows stay", () => {
    const out = swapMatchRights(pairs, 0, 1);
    expect(out).toEqual([
      { id: "p1", left: "France", right: "Paris" },
      { id: "p2", left: "Italy", right: "Rome" },
      { id: "p3", left: "Spain", right: "Madrid" },
    ]);
  });
  test("a non-adjacent swap leaves the row between untouched", () => {
    expect(swapMatchRights(pairs, 2, 0).map((p) => p.right)).toEqual(["Madrid", "Paris", "Rome"]);
  });
  test("is its own inverse", () => {
    expect(swapMatchRights(swapMatchRights(pairs, 0, 2), 0, 2)).toEqual(pairs);
  });
  test("equal or out-of-range rows change nothing and never mutate the input", () => {
    const before = JSON.stringify(pairs);
    expect(swapMatchRights(pairs, 1, 1)).toEqual(pairs);
    expect(swapMatchRights(pairs, 0, 7)).toEqual(pairs);
    expect(JSON.stringify(pairs)).toBe(before);
  });
});

describe("announcements", () => {
  test("a swap names both new matches", () => {
    const out = swapMatchRights(pairs, 0, 1);
    expect(matchSwapAnnouncement(out, 0, 1)).toBe("France now matches Paris. Italy now matches Rome.");
  });
  test("empty text falls back to a position", () => {
    const out = swapMatchRights([{ id: "a", left: "", right: "x" }, { id: "b", left: "B", right: "" }], 0, 1);
    expect(matchSwapAnnouncement(out, 0, 1)).toBe("Left 1 now matches an empty right. B now matches x.");
  });
  test("long text is cut", () => {
    expect(keyExcerpt("a".repeat(60), "f")).toBe(`${"a".repeat(39)}…`);
    expect(keyExcerpt("  two\n lines ", "f")).toBe("two lines");
  });
  test("a step move says where it went", () => {
    expect(stepMoveAnnouncement(3, 0, 4)).toBe("Step 4 moved. It is now step 1 of 4.");
    expect(stepMoveAnnouncement(1, 1, 4)).toBe("Step 2 did not move.");
  });
});

describe("ordering key", () => {
  test("a moved step keeps its id, so the key is the new order", () => {
    const seq = [
      { id: "s1", label: "one" },
      { id: "s2", label: "two" },
      { id: "s3", label: "three" },
    ];
    expect(moveInList(seq, 2, 0).map((e) => e.id)).toEqual(["s3", "s1", "s2"]);
  });
});
