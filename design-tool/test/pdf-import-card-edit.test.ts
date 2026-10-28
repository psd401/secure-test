// Beta report 2026-10-28: editing an import card before Accept (stem,
// choices, and the MC / short-text key). The pure helpers in
// lib/pdfImport/cardEdit.ts and the triage rule that an edited field's
// "check" reasons are answered. No database.
import { describe, expect, test } from "bun:test";
import { CreateItemBody } from "../lib/api/items";
import {
  addChoice,
  editableKey,
  editedFields,
  editsChoices,
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
