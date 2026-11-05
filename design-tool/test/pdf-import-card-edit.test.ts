// Beta report 2026-10-28: editing an import card before Accept (stem,
// choices, and the MC / short-text key). The pure helpers in
// lib/pdfImport/cardEdit.ts and the triage rule that an edited field's
// "check" reasons are answered. No database.
import { describe, expect, test } from "bun:test";
import type { FillBlankBlank } from "@secure-test/schema";
import { CreateItemBody } from "../lib/api/items";
import { MAX_BLANKS, insertBlankAt } from "../lib/items/fillBlankEditor";
import {
  addBlank,
  addChoice,
  BLANK_LIMIT_TITLE,
  canInsertBlank,
  editableKey,
  editedFields,
  editsChoices,
  newBlank,
  removeChoice,
  setChoiceText,
  setStem,
  toggleKey,
} from "../lib/pdfImport/cardEdit";
import { triageCandidate } from "../lib/pdfImport/triage";

const MC = {
  type: "multiple_choice_single",
  stem: "Which angle is acute?",
  choices: [
    { id: "a", text: "$30^\\circ$" },
    { id: "b", text: "$120^\\circ$" },
  ],
  correct_choice_ids: [] as string[],
};

describe("which parts of a card are editable", () => {
  test("MC types edit choices and a choice key; short text an answer; others neither", () => {
    expect(editableKey("multiple_choice_single")).toBe("single");
    expect(editableKey("multiple_choice_multi")).toBe("multi");
    expect(editableKey("short_text")).toBe("answer");
    for (const t of ["match", "fill_blank", "table", "essay", "drawing_upload"]) {
      expect(editableKey(t)).toBeNull();
      expect(editsChoices(t)).toBe(false);
    }
    expect(editsChoices("multiple_choice_multi")).toBe(true);
    expect(editsChoices("short_text")).toBe(false);
  });
});

describe("choice and key edits", () => {
  test("text, add and remove; a removed choice leaves the key", () => {
    let c = setChoiceText(MC, "b", "$90^\\circ$");
    expect(c.choices[1]).toEqual({ id: "b", text: "$90^\\circ$" });
    c = addChoice(c);
    expect(c.choices.map((ch) => ch.id)).toEqual(["a", "b", "c"]);
    expect(c.choices[2]!.text).toBe("");
    c = toggleKey(c, "c");
    c = removeChoice(c, "c");
    expect(c.choices.map((ch) => ch.id)).toEqual(["a", "b"]);
    expect(c.correct_choice_ids).toEqual([]);
    // The proposal itself is never mutated.
    expect(MC.choices).toHaveLength(2);
  });

  test("single choice replaces the key; multi toggles and keeps choice order", () => {
    expect(toggleKey(toggleKey(MC, "b"), "a").correct_choice_ids).toEqual(["a"]);
    const multi = { ...MC, type: "multiple_choice_multi" };
    const both = toggleKey(toggleKey(multi, "b"), "a");
    expect(both.correct_choice_ids).toEqual(["a", "b"]);
    expect(toggleKey(both, "b").correct_choice_ids).toEqual(["a"]);
  });

  test("an edited card still goes through the item schema on Accept", () => {
    const edited = toggleKey(setChoiceText({ ...MC, stem: "Which angle is **acute**?" }, "a", "$45^\\circ$"), "a");
    expect(CreateItemBody.safeParse(edited).success).toBe(true);
  });
});

// PR #146 review: deleting a blank chip on the card must not make Accept fail.
describe("setStem", () => {
  const fb = {
    type: "fill_blank",
    stem: "Area = [[b1]] and perimeter = [[b2]].",
    blanks: [
      { id: "b1", kind: "text" as const, keys: ["12"] },
      { id: "b2", kind: "text" as const, keys: ["14"] },
    ],
  };

  test("a deleted chip drops its blank; the rest follow the stem's order", () => {
    expect(setStem(fb, "Perimeter = [[b2]].").blanks!.map((b) => b.id)).toEqual(["b2"]);
    expect(setStem(fb, "[[b2]] then [[b1]]").blanks!.map((b) => b.id)).toEqual(["b2", "b1"]);
  });

  test("the edited card passes the item schema; keeping the orphan would not", () => {
    expect(CreateItemBody.safeParse(fb).success).toBe(true);
    expect(CreateItemBody.safeParse(setStem(fb, "Perimeter = [[b2]].")).success).toBe(true);
    expect(CreateItemBody.safeParse({ ...fb, stem: "Perimeter = [[b2]]." }).success).toBe(false);
  });

  test("other types only change the stem", () => {
    expect(setStem(MC, "New?")).toEqual({ ...MC, stem: "New?" });
  });
});

// Insert blank on an import card, as in the editor: onInsert adds the blank
// (keyed by the selection), then the field's chip arrives through setStem.
describe("Insert blank", () => {
  const fb = {
    type: "fill_blank",
    stem: "The windward side is wet and the leeward side is dry.",
    blanks: [] as FillBlankBlank[],
  };

  test("the selected text becomes the new blank's key; the chip keeps it through setStem", () => {
    const blank = newBlank(fb, "leeward");
    expect(blank).toEqual({ id: "b1", kind: "text", keys: ["leeward"] });
    const withBlank = addBlank(fb, blank);
    const stem = "The windward side is wet and the [[b1]] side is dry.";
    const edited = setStem(withBlank, stem);
    expect(edited.stem).toBe(stem);
    expect(edited.blanks).toEqual([blank]);
    expect(CreateItemBody.safeParse(edited).success).toBe(true);
  });

  test("no selection: a blank with no key yet; a second blank never reuses a number", () => {
    expect(newBlank(fb, "")).toEqual({ id: "b1", kind: "text" });
    const one = setStem(addBlank(fb, newBlank(fb, "windward")), "The [[b1]] side is wet.");
    expect(newBlank(one, "").id).toBe("b2");
    const two = setStem(addBlank(one, newBlank(one, "wet")), "The [[b1]] side is [[b2]].");
    expect(two.blanks!.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(CreateItemBody.safeParse(two).success).toBe(true);
  });

  test("matches the editor's insertBlankAt on the same selection", () => {
    const start = fb.stem.indexOf("leeward");
    const viaEditor = insertBlankAt(fb.stem, [], start, start + "leeward".length);
    const viaCard = setStem(addBlank(fb, newBlank(fb, "leeward")), viaEditor.stem);
    expect(viaCard.blanks).toEqual(viaEditor.blanks);
  });

  test("the editor's limit and title", () => {
    const blanks = Array.from({ length: MAX_BLANKS }, (_, n) => ({ id: `b${n + 1}`, kind: "text" as const }));
    expect(canInsertBlank({ blanks: blanks.slice(1) })).toBe(true);
    expect(canInsertBlank({ blanks })).toBe(false);
    expect(canInsertBlank({})).toBe(true);
    expect(BLANK_LIMIT_TITLE).toBe(`A question allows at most ${MAX_BLANKS} blanks`);
  });
});

describe("editedFields", () => {
  test("names the stem and the choices only when they differ; a key edit names neither", () => {
    expect([...editedFields(MC, MC)]).toEqual([]);
    expect([...editedFields(MC, { ...MC, stem: "Which angle is acute? " })]).toEqual(["stem"]);
    expect([...editedFields(MC, setChoiceText(MC, "a", "30°"))]).toEqual(["choices"]);
    expect([...editedFields(MC, addChoice(MC))]).toEqual(["choices"]);
    expect([...editedFields(MC, removeChoice(MC, "a"))]).toEqual(["choices"]);
    expect([...editedFields(MC, toggleKey(MC, "a"))]).toEqual([]);
  });
});

describe("triage with reviewed fields", () => {
  const changed = {
    candidate: { ...MC, stem: "Which angle is acute? Type the letter." },
    needsKey: false,
    changes: [
      { original: "Circle the letter.", changed_to: "Type the letter.", reason: "cannot circle" },
      { original: "120°", changed_to: "$120^\\circ$", reason: "math" },
    ],
  };

  test("an edited field's reasons are dropped; the other field's stay", () => {
    const before = triageCandidate(changed);
    expect(before.reasons.map((r) => r.field)).toEqual(["stem", "choices"]);
    const t = triageCandidate({ ...changed, reviewed: new Set(["stem"] as const) });
    expect(t.status).toBe("check");
    expect(t.reasons.map((r) => r.field)).toEqual(["choices"]);
  });

  test("with every reason answered the card falls to its key status", () => {
    const reviewed = new Set(["stem", "choices"] as const);
    expect(triageCandidate({ ...changed, reviewed }).status).toBe("ready");
    expect(triageCandidate({ ...changed, needsKey: true, reviewed }).status).toBe("needs_key");
  });

  test("an edit does not answer a reason about the stimulus or the type", () => {
    const t = triageCandidate({
      candidate: MC,
      needsKey: false,
      set: { source: "adjacency" },
      reviewed: new Set(["stem", "choices"] as const),
    });
    expect(t.status).toBe("check");
    expect(t.reasons[0]!.code).toBe("paired_by_position");
  });
});
