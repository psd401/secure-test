// FB slice 2 (docs/fill-in-blank-design.md): the pure logic behind the
// fill-in-the-blank editor form. No DOM harness in this repo, so clicks stay
// manual rows (docs/design-tool-manual-checks.md); what a click decides is here.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FillBlankBlank, FillBlankDropdown } from "@secure-test/schema";
import {
  FILL_BLANK_SEED_STEM,
  addBlankForMarker,
  blankCountLine,
  blanksForSave,
  blanksWithoutKeys,
  copyOptionsFrom,
  duplicateMarkers,
  fillBlankIssueMessages,
  hasKeyedBlank,
  insertBlankAt,
  nextBlankId,
  nextOptionId,
  orderBlanksByStem,
  orphanMarkers,
  removeBlank,
  removeMarker,
  restoreMarker,
  setBlankKind,
} from "../lib/items/fillBlankEditor";
import { FillBlankEditor } from "../app/dashboard/[id]/FillBlankEditor";
import { CreateItemBody } from "../lib/api/items";

const drop = (id: string, texts: string[], correct?: string): FillBlankDropdown => ({
  id,
  kind: "dropdown",
  options: texts.map((text, i) => ({ id: `o${i + 1}`, text })),
  ...(correct ? { correct_option_id: correct } : {}),
});

describe("ids", () => {
  test("nextBlankId is one past the highest b<n> in blanks or markers, never reused", () => {
    expect(nextBlankId("", [])).toBe("b1");
    expect(nextBlankId("a [[b1]] b [[b3]]", [{ id: "b1" }, { id: "b3" }])).toBe("b4");
    // b1 removed: not handed out again.
    expect(nextBlankId("a [[b2]]", [{ id: "b2" }])).toBe("b3");
    // a stray marker counts as taken
    expect(nextBlankId("a [[b7]]", [])).toBe("b8");
    // non-generated ids are ignored
    expect(nextBlankId("a [[x]]", [{ id: "x" }])).toBe("b1");
  });
  test("nextOptionId", () => {
    expect(nextOptionId([{ id: "o1" }, { id: "o2" }])).toBe("o3");
    expect(nextOptionId([{ id: "o1" }, { id: "o3" }])).toBe("o4");
  });
});

describe("insertBlankAt", () => {
  test("at a caret: a typed blank, padded away from words, caret after the marker", () => {
    const out = insertBlankAt("The side", [], 3, 3);
    expect(out.stem).toBe("The [[b1]] side");
    expect(out.blanks).toEqual([{ id: "b1", kind: "text" }]);
    expect(out.stem.slice(0, out.caret)).toBe("The [[b1]]");
  });
  test("a selection becomes the marker and the blank's first accepted answer", () => {
    const out = insertBlankAt("The leeward side", [], 4, 11);
    expect(out.stem).toBe("The [[b1]] side");
    expect(out.blanks).toEqual([{ id: "b1", kind: "text", keys: ["leeward"] }]);
  });
  test("inserting before an existing blank keeps the list in stem order", () => {
    const blanks: FillBlankBlank[] = [{ id: "b1", kind: "text" }];
    const out = insertBlankAt("A [[b1]] end", blanks, 0, 0);
    expect(out.stem).toBe("[[b2]] A [[b1]] end");
    expect(out.blanks.map((b) => b.id)).toEqual(["b2", "b1"]);
  });
  test("out-of-range positions clamp", () => {
    expect(insertBlankAt("x", [], 99, 99).stem).toBe("x [[b1]]");
  });
});

describe("stem order", () => {
  test("orderBlanksByStem follows first marker appearance; orphans kept at the end", () => {
    const blanks: FillBlankBlank[] = [
      { id: "b1", kind: "text" },
      { id: "b9", kind: "text" },
      { id: "b2", kind: "text" },
    ];
    expect(orderBlanksByStem("[[b2]] then [[b1]]", blanks).map((b) => b.id)).toEqual(["b2", "b1", "b9"]);
  });
  test("blanksForSave orders and compacts keys", () => {
    const blanks: FillBlankBlank[] = [
      { id: "b1", kind: "text", keys: ["  ", "leeward", ""], exact_form: false },
      drop("b2", ["wet", "dry"]),
    ];
    expect(blanksForSave("[[b2]] and [[b1]]", blanks)).toEqual([
      drop("b2", ["wet", "dry"]),
      { id: "b1", kind: "text", keys: ["leeward"] },
    ]);
    expect(blanksForSave("[[b1]]", [{ id: "b1", kind: "text", keys: [""], exact_form: true }])).toEqual([
      { id: "b1", kind: "text", exact_form: true },
    ]);
  });
});

describe("removing and restoring", () => {
  test("removeMarker tidies the space it leaves", () => {
    expect(removeMarker("the [[b1]] side", "b1")).toBe("the side");
    expect(removeMarker("[[b1]] side", "b1")).toBe("side");
    expect(removeMarker("the [[b1]].", "b1")).toBe("the.");
    expect(removeMarker("a [[b1]] b [[b1]] c", "b1")).toBe("a b c");
  });
  test("removeBlank drops the entry and its marker", () => {
    const out = removeBlank("a [[b1]] b [[b2]]", [{ id: "b1", kind: "text" }, { id: "b2", kind: "text" }], "b1");
    expect(out).toEqual({ stem: "a b [[b2]]", blanks: [{ id: "b2", kind: "text" }] });
  });
  test("a deleted marker leaves the blank in place, and Put back appends it", () => {
    const blanks: FillBlankBlank[] = [{ id: "b1", kind: "text", keys: ["x"] }, { id: "b2", kind: "text" }];
    const stem = "a [[b2]]"; // the teacher deleted [[b1]] by hand
    expect(orderBlanksByStem(stem, blanks).map((b) => b.id)).toEqual(["b2", "b1"]);
    const back = restoreMarker(stem, blanks, "b1");
    expect(back.stem).toBe("a [[b2]] [[b1]]");
    expect(back.blanks.map((b) => b.id)).toEqual(["b2", "b1"]);
    expect(restoreMarker("", [], "b1").stem).toBe("[[b1]]");
  });
  test("orphan and duplicate markers", () => {
    expect(orphanMarkers("a [[b1]] [[b5]] [[b5]]", [{ id: "b1" }])).toEqual(["b5"]);
    expect(duplicateMarkers("a [[b1]] [[b1]] [[b2]]")).toEqual(["b1"]);
    expect(addBlankForMarker("[[b5]] [[b1]]", [{ id: "b1", kind: "text" }], "b5").map((b) => b.id)).toEqual([
      "b5",
      "b1",
    ]);
  });
});

describe("kind and options", () => {
  test("dropdown → typed keeps the correct option's text as the answer", () => {
    expect(setBlankKind(drop("b1", ["wet", "dry"], "o2"), "text")).toEqual({ id: "b1", kind: "text", keys: ["dry"] });
    expect(setBlankKind(drop("b1", ["wet", "dry"]), "text")).toEqual({ id: "b1", kind: "text" });
  });
  test("typed → dropdown turns answers into options (padded to two), first correct", () => {
    expect(setBlankKind({ id: "b1", kind: "text", keys: ["leeward"] }, "dropdown")).toEqual({
      id: "b1",
      kind: "dropdown",
      options: [
        { id: "o1", text: "leeward" },
        { id: "o2", text: "" },
      ],
      correct_option_id: "o1",
    });
    expect(setBlankKind({ id: "b1", kind: "text" }, "dropdown")).toEqual(drop("b1", ["", ""]));
  });
  test("Same options as blank n copies the list; the target keeps its answer only by matching text", () => {
    const src = drop("b1", ["wet", "dry", "cold"], "o1");
    expect(copyOptionsFrom(drop("b2", ["x", "y"]), src)).toEqual({ ...drop("b2", ["wet", "dry", "cold"]) });
    expect(copyOptionsFrom(drop("b2", ["cold", "y"], "o1"), src)).toEqual(drop("b2", ["wet", "dry", "cold"], "o3"));
  });
});

describe("keys and the live line (E3-F1)", () => {
  test("hasKeyedBlank ignores blank accepted answers", () => {
    expect(hasKeyedBlank(null)).toBe(false);
    expect(hasKeyedBlank([{ id: "b1", kind: "text", keys: [" "] }])).toBe(false);
    expect(hasKeyedBlank([drop("b1", ["a", "b"], "o1")])).toBe(true);
  });
  test("blankCountLine", () => {
    expect(blankCountLine([{ id: "b1", kind: "text" }])).toBe(
      "No blank has an answer yet, so this question is hand-scored until you add some",
    );
    expect(blankCountLine([drop("b1", ["a", "b"], "o1"), { id: "b2", kind: "text", keys: ["x"] }])).toBe(
      "2 blanks checked, one point each",
    );
    expect(blankCountLine([drop("b1", ["a", "b"], "o1"), { id: "b2", kind: "text" }])).toBe(
      "1 blank checked, one point each; a blank with no answer is not scored",
    );
  });
  test("blanksWithoutKeys: a key-only edit compares equal, an option edit does not", () => {
    const a: FillBlankBlank[] = [drop("b1", ["a", "b"]), { id: "b2", kind: "text" }];
    const keyed: FillBlankBlank[] = [drop("b1", ["a", "b"], "o2"), { id: "b2", kind: "text", keys: ["x", ""] }];
    expect(JSON.stringify(blanksWithoutKeys(keyed))).toBe(JSON.stringify(blanksWithoutKeys(a)));
    const reworded: FillBlankBlank[] = [drop("b1", ["a", "c"]), { id: "b2", kind: "text" }];
    expect(JSON.stringify(blanksWithoutKeys(reworded))).not.toBe(JSON.stringify(blanksWithoutKeys(a)));
    const exact: FillBlankBlank[] = [drop("b1", ["a", "b"]), { id: "b2", kind: "text", exact_form: true }];
    expect(JSON.stringify(blanksWithoutKeys(exact))).not.toBe(JSON.stringify(blanksWithoutKeys(a)));
  });
});

describe("the write boundary agrees", () => {
  test("the Add seed passes slice 1's CreateItemBody", () => {
    const parsed = CreateItemBody.safeParse({
      type: "fill_blank",
      stem: FILL_BLANK_SEED_STEM,
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      blanks: [{ id: "b1", kind: "text" }],
    });
    expect(parsed.success).toBe(true);
  });
  test("fillBlankIssueMessages picks the blank messages out of a 400's detail", () => {
    const parsed = CreateItemBody.safeParse({
      type: "fill_blank",
      stem: "a [[b1]]",
      blanks: [{ id: "b1", kind: "text" }, { id: "b2", kind: "text" }],
    });
    expect(parsed.success).toBe(false);
    const msgs = fillBlankIssueMessages(parsed.success ? undefined : parsed.error.message);
    expect(msgs).toEqual(['blank "b2" has no [[b2]] marker in the stem']);
    expect(fillBlankIssueMessages("not json")).toEqual([]);
    expect(fillBlankIssueMessages(undefined)).toEqual([]);
  });
});

describe("FillBlankEditor markup", () => {
  const blanks: FillBlankBlank[] = [drop("b1", ["wet", "dry"], "o1"), { id: "b2", kind: "text", keys: ["leeward"] }];
  function html(disabled: boolean, stem = "The [[b1]] side and the [[b2]] side.") {
    return renderToStaticMarkup(
      <FillBlankEditor itemId="i1" stem={stem} blanks={blanks} onChange={() => {}} disabled={disabled} />,
    );
  }
  /** The one tag carrying `aria-label="<label>"`. */
  function tag(out: string, label: string): string {
    const m = new RegExp(`<[^<>]*aria-label="${label}"[^<>]*>`).exec(out);
    if (!m) throw new Error(`no tag labelled ${label}`);
    return m[0];
  }
  test("numbers blanks in list order and shows the live line", () => {
    const out = html(false);
    expect(out).toContain("Blank 1");
    expect(out).toContain("Blank 2");
    expect(out).toContain("2 blanks checked, one point each");
    expect(out).toContain("Answer form matters (exact match only)");
    // "Same options as" is offered only when another dropdown exists
    expect(out).not.toContain("Same options as");
    const two = renderToStaticMarkup(
      <FillBlankEditor
        itemId="i1"
        stem="[[b1]] [[b2]]"
        blanks={[drop("b1", ["a", "b"]), drop("b2", ["c", "d"])]}
        onChange={() => {}}
        disabled={false}
      />,
    );
    expect(two).toContain("Same options as");
    expect(two).toContain('<option value="0">Blank 1</option>');
  });
  test("published: structure disabled, keys editable", () => {
    const out = html(true);
    // option text inputs are disabled, the correct-option radios are not
    expect(tag(out, "Blank 1 option 1")).toContain('disabled=""');
    expect(tag(out, "Mark option 1 of blank 1 as correct")).not.toContain("disabled");
    // accepted answers stay editable; the exact-form switch is locked
    expect(tag(out, "Blank 2 accepted answer 1")).not.toContain("disabled");
    expect(out).toMatch(/<input type="checkbox" disabled=""\/>/);
    // and in a draft nothing is disabled but the min-2 option Remove buttons
    expect(tag(html(false), "Blank 1 option 1")).not.toContain("disabled");
  });
  test("a blank whose marker is gone is shown, not dropped; an orphan marker is offered a blank", () => {
    const out = html(false, "The [[b1]] side and [[b7]].");
    expect(out).toContain("Not in the question any more.");
    expect(out).toContain("Put it back (at the end)");
    expect(out).toContain("[[b7]]</code> in the question has no blank.");
  });
});
