// Phase 4 slice C (docs/editor-redesign-design.md): fill-in-the-blank stems in
// the new field. "Insert blank" on the ProseMirror document must give the same
// stem the current editor's `insertBlankAt` gives for the same caret or
// selection, and the field must load / save a stem's blank markers as chips.

import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { insertBlankTr, selectedBlankKey } from "@/lib/authoring/blankInsert";
import { docToMarkup, markupToDoc } from "@/lib/authoring/markupDoc";
import { markupExtensions } from "@/lib/authoring/markupExtensions";
import { insertBlankAt, nextBlankId } from "@/lib/items/fillBlankEditor";
import type { FillBlankBlank } from "@secure-test/schema";

const schema = getSchema(markupExtensions());

function stateFor(stem: string, ids: string[], from: number, to = from) {
  const doc = schema.nodeFromJSON(markupToDoc(stem, { blanks: ids }).doc);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

/** Insert through the field's path; `blanks` is the item's list BEFORE the insert (the field's prop lags). */
function fieldInsert(stem: string, blanks: FillBlankBlank[], pmFrom: number, pmTo = pmFrom) {
  const ids = blanks.map((b) => b.id);
  const state = stateFor(stem, ids, pmFrom, pmTo);
  const key = selectedBlankKey(state);
  const id = nextBlankId(stem, blanks);
  const next = state.apply(insertBlankTr(state, id));
  return { saved: docToMarkup(next.doc.toJSON(), { blanks: ids }), key, caret: next.selection.from };
}

describe("Insert blank matches the current editor", () => {
  // Plain-text stems: text offset n is document position n + 1 (a "\n" is one
  // hardBreak, also size 1), so both editors see the same caret.
  const cases: [string, number, number][] = [
    ["The cat sat.", 4, 4], // inside a gap between words
    ["The cat sat.", 5, 5], // touching words both sides → padded both sides
    ["The cat sat.", 4, 7], // selection "cat" becomes the key
    ["The cat sat.", 12, 12], // at the end, after "."
    ["The cat sat.", 0, 0], // at the start
    ["word", 2, 2], // mid-word
    ["one\ntwo", 3, 3], // before a line break
    ["", 0, 0], // empty stem
  ];
  for (const [stem, s, e] of cases) {
    test(JSON.stringify([stem, s, e]), () => {
      const old = insertBlankAt(stem, [], s, e);
      const got = fieldInsert(stem, [], s + 1, e + 1);
      expect(got.saved).toEqual({ markup: old.stem, exact: true });
      expect(got.key).toBe(stem.slice(s, e).trim());
      // Just after the blank: the marker is one chip (size 1), offset by the paragraph's opening position.
      expect(got.caret).toBe(old.caret - "[[b1]]".length + 2);
    });
  }

  test("a second blank gets the next id beside an existing chip", () => {
    const stem = "A [[b1]] and B.";
    const blanks: FillBlankBlank[] = [{ id: "b1", kind: "text" }];
    // Position 9 is just before "B": "A " (1–2), the b1 chip (3), " and " (4–8).
    const got = fieldInsert(stem, blanks, 9);
    expect(got.saved).toEqual({ markup: "A [[b1]] and [[b2]] B.", exact: true });
  });

  test("inside bold, the stem stays valid markup and saves exactly", () => {
    const got = fieldInsert("**big** word", [], 2); // between "b" and "ig"
    expect(got.saved.exact).toBe(true);
    expect(got.saved.markup).toBe("**b** [[b1]] **ig** word");
  });
});

describe("loading a fill-in-the-blank stem", () => {
  test("its markers load as chips and save back unchanged", () => {
    const stem = "x [[b1]] y [[b2]].";
    const loaded = markupToDoc(stem, { blanks: ["b1", "b2"] });
    expect(loaded.representable).toBe(true);
    const chips = (loaded.doc.content?.[0]?.content ?? []).filter((n) => n.type === "blank");
    expect(chips.map((n) => n.attrs?.id)).toEqual(["b1", "b2"]);
    expect(docToMarkup(schema.nodeFromJSON(loaded.doc).toJSON(), { blanks: ["b1", "b2"] })).toEqual({
      markup: stem,
      exact: true,
    });
  });
  test("a marker naming no blank stays text", () => {
    const loaded = markupToDoc("x [[b9]]", { blanks: ["b1"] });
    expect((loaded.doc.content?.[0]?.content ?? []).some((n) => n.type === "blank")).toBe(false);
  });
  test("a copied chip (the same blank twice) saves as not exact: students would see the second as text", () => {
    const loaded = markupToDoc("[[b1]]", { blanks: ["b1"] });
    const para = loaded.doc.content![0]!;
    const twice = { ...loaded.doc, content: [{ ...para, content: [...para.content!, ...para.content!] }] };
    expect(docToMarkup(twice, { blanks: ["b1"] })).toEqual({ markup: "[[b1]][[b1]]", exact: false });
  });
  test("deleting a chip removes its marker", () => {
    const loaded = markupToDoc("a [[b1]] b", { blanks: ["b1"] });
    const para = loaded.doc.content![0]!;
    const without = { ...loaded.doc, content: [{ ...para, content: para.content!.filter((n) => n.type !== "blank") }] };
    expect(docToMarkup(schema.nodeFromJSON(without).toJSON(), { blanks: ["b1"] }).markup).toBe("a  b");
  });
});
