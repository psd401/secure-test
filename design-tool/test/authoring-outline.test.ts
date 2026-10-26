// R-6 / R-7 (docs/editor-redesign-design.md, Phase 4 slice B): the position
// logic behind the new editor's outline rail, "+" insertion points, "/" menu
// and choice reorder. Pure — no database, no DOM.
import { describe, expect, test } from "bun:test";
import { ITEM_TYPES } from "../db/schema";
import { splitSetInOrder } from "../lib/api/itemSets";
import {
  blockMoveAnnouncement,
  choiceLetter,
  choiceMoveAnnouncement,
  insertAt,
  insertionSlots,
  moveBlockBy,
  moveBlockTo,
  moveInList,
  outlineBlocks,
  slashOpensInsertMenu,
  slotAfter,
  splitsSet,
  TEXT_ENTRY_SELECTOR,
} from "../lib/authoring/outline";
import { INSERT_MENU_COMMON, INSERT_MENU_MORE, filterInsertTypes } from "../lib/authoring/insertTypes";
import { ITEM_TYPE_LABEL } from "../lib/items/typeLabel";
import { prng } from "../../packages/markup/test/fuzz";

// q1 | (q2 q3 q4 in set S) | q5 | (q6 q7 in set T)
const LIST = [
  { id: "q1" },
  { id: "q2", item_set_id: "S" },
  { id: "q3", item_set_id: "S" },
  { id: "q4", item_set_id: "S" },
  { id: "q5", item_set_id: null },
  { id: "q6", item_set_id: "T" },
  { id: "q7", item_set_id: "T" },
];
const ids = (l: { id: string }[] | null) => (l ? l.map((i) => i.id) : null);

describe("blocks", () => {
  test("a set's questions are one block, keyed by the set; a lone question by its id", () => {
    const blocks = outlineBlocks(LIST);
    expect(blocks.map((b) => [b.key, b.start, b.items.length])).toEqual([
      ["q1", 0, 1],
      ["S", 1, 3],
      ["q5", 4, 1],
      ["T", 5, 2],
    ]);
  });

  test("splitsSet agrees with the reorder route's splitSetInOrder on random orders", () => {
    const rand = prng(7);
    const setOf = new Map(LIST.map((i) => [i.id, i.item_set_id ?? null]));
    for (let n = 0; n < 2000; n++) {
      const order = [...LIST];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      expect(splitsSet(order)).toBe(splitSetInOrder(order.map((i) => i.id), setOf) !== null);
    }
  });
});

describe("moving blocks", () => {
  test("drag: a set moves whole, and no block move ever splits a set", () => {
    expect(ids(moveBlockTo(LIST, 1, 3))).toEqual(["q1", "q5", "q6", "q7", "q2", "q3", "q4"]);
    expect(ids(moveBlockTo(LIST, 3, 0))).toEqual(["q6", "q7", "q1", "q2", "q3", "q4", "q5"]);
    const blocks = outlineBlocks(LIST).length;
    for (let from = 0; from < blocks; from++) {
      for (let to = 0; to < blocks; to++) {
        const next = moveBlockTo(LIST, from, to);
        if (from === to) expect(next).toBeNull();
        else {
          expect(next).toHaveLength(LIST.length);
          expect(splitsSet(next!)).toBe(false);
        }
      }
    }
  });

  test("click path: Move up / Move down by one block, from any question of the block", () => {
    expect(ids(moveBlockBy(LIST, "q3", -1))).toEqual(["q2", "q3", "q4", "q1", "q5", "q6", "q7"]);
    expect(ids(moveBlockBy(LIST, "q5", 1))).toEqual(["q1", "q2", "q3", "q4", "q6", "q7", "q5"]);
    expect(moveBlockBy(LIST, "q1", -1)).toBeNull();
    expect(moveBlockBy(LIST, "q7", 1)).toBeNull();
    expect(moveBlockBy(LIST, "nope", 1)).toBeNull();
  });

  test("announcements name the old and new positions", () => {
    const next = moveBlockBy(LIST, "q5", -1)!;
    expect(blockMoveAnnouncement(LIST, next, "q5")).toBe("Question 5 moved. It is now question 2 of 7.");
    const set = moveBlockTo(LIST, 1, 0)!;
    expect(blockMoveAnnouncement(LIST, set, "q2")).toBe(
      "Questions 2 to 4 (one stimulus) moved. They are now questions 1 to 3 of 7.",
    );
    expect(blockMoveAnnouncement(LIST, LIST, "q1")).toBe("Question 1 did not move.");
  });
});

describe("insertion", () => {
  test("slots sit before every block and at the end — never inside a set", () => {
    expect(insertionSlots(LIST)).toEqual([0, 1, 4, 5, 7]);
    expect(insertionSlots([])).toEqual([0]);
    for (const slot of insertionSlots(LIST)) {
      expect(splitsSet(insertAt(LIST, { id: "new", item_set_id: null }, slot))).toBe(false);
    }
    // …whereas a position inside the set would split it.
    expect(splitsSet(insertAt(LIST, { id: "new", item_set_id: null }, 2))).toBe(true);
  });

  test("'/' on a card inserts after its block", () => {
    expect(slotAfter(LIST, "q1")).toBe(1);
    expect(slotAfter(LIST, "q3")).toBe(4);
    expect(slotAfter(LIST, "q7")).toBe(7);
    expect(slotAfter(LIST, "missing")).toBe(7);
  });

  test("'/' opens the menu only on the card itself, not in a field or a math field", () => {
    const key = { key: "/", metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, inTextField: false };
    expect(slashOpensInsertMenu(key)).toBe(true);
    expect(slashOpensInsertMenu({ ...key, key: "a" })).toBe(false);
    expect(slashOpensInsertMenu({ ...key, metaKey: true })).toBe(false);
    expect(slashOpensInsertMenu({ ...key, inTextField: true })).toBe(false);
    // Review finding: MathLive's "/" (a fraction) calls preventDefault and
    // bubbles out with the <math-field> host as its target.
    expect(slashOpensInsertMenu({ ...key, defaultPrevented: true })).toBe(false);
    expect(TEXT_ENTRY_SELECTOR.split(",").map((s) => s.trim())).toContain("math-field");
  });

  test("insertAt puts the item at the index, clamped", () => {
    expect(insertAt(["a", "b"], "x", 0)).toEqual(["x", "a", "b"]);
    expect(insertAt(["a", "b"], "x", 1)).toEqual(["a", "x", "b"]);
    expect(insertAt(["a", "b"], "x", 9)).toEqual(["a", "b", "x"]);
    expect(insertAt(["a", "b"], "x", -3)).toEqual(["x", "a", "b"]);
  });

  test("the menu's two lists cover every item type exactly once, six first", () => {
    expect(INSERT_MENU_COMMON).toHaveLength(6);
    expect([...INSERT_MENU_COMMON, ...INSERT_MENU_MORE].sort()).toEqual([...ITEM_TYPES].sort());
  });

  test("typing filters by label or type name", () => {
    const label = (t: (typeof ITEM_TYPES)[number]) => ITEM_TYPE_LABEL[t];
    expect(filterInsertTypes("ess", label)).toEqual(["essay"]);
    expect(filterInsertTypes("multiple", label)).toEqual(["multiple_choice_single", "multiple_choice_multi"]);
    expect(filterInsertTypes("drawing", label)).toEqual(["drawing_upload"]);
    expect(filterInsertTypes("  ", label)).toHaveLength(ITEM_TYPES.length);
    expect(filterInsertTypes("zzz", label)).toEqual([]);
  });
});

describe("choices", () => {
  test("moveInList moves one entry and keeps the rest in order", () => {
    expect(moveInList(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveInList(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveInList(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  test("letters follow position, as the preview letters them", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(choiceLetter)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
    expect(choiceMoveAnnouncement(2, 0, 4)).toBe("Choice C moved. It is now choice A of 4.");
  });
});
