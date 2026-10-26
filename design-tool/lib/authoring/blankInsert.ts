import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { MARKUP_NODE } from "./markupDoc";

// Phase 4 slice C (docs/editor-redesign-design.md), behind the R-12 flag:
// "Insert blank" in the new field. The same rule as the current editor's
// `insertBlankAt` (lib/items/fillBlankEditor.ts), applied to the ProseMirror
// document instead of the markup string: the blank replaces the selection,
// whose text becomes the blank's first accepted answer, and a space is added
// on a side where the blank would otherwise touch a word character. Pure, so
// test/authoring-fill-blank-field.test.ts checks it against `insertBlankAt`.

/** The selection's plain text, trimmed: the new blank's first accepted answer ("" = none). */
export function selectedBlankKey(state: EditorState): string {
  const { from, to } = state.selection;
  return state.doc.textBetween(from, to, "", "").trim();
}

/** The one paragraph's content range: [start, end] in document positions. */
function paragraphRange(doc: PMNode): { start: number; end: number } {
  return { start: 1, end: doc.content.size - 1 };
}

/**
 * A transaction that puts blank `id` where the selection is (replacing it) and
 * leaves the cursor just after the blank. When the field is not focused the
 * caller moves the selection to the end first, as `insertBlankAt` puts the
 * marker at the end of the sentence then.
 */
export function insertBlankTr(state: EditorState, id: string): Transaction {
  const { schema, doc } = state;
  const { start, end } = paragraphRange(doc);
  const from = Math.max(start, Math.min(state.selection.from, end));
  const to = Math.max(from, Math.min(state.selection.to, end));
  const before = from > start ? doc.textBetween(from - 1, from, "", "") : "";
  const after = to < end ? doc.textBetween(to, to + 1, "", "") : "";
  const padL = /\w$/.test(before);
  const padR = /^\w/.test(after);
  const nodes: PMNode[] = [];
  if (padL) nodes.push(schema.text(" "));
  nodes.push(schema.nodes[MARKUP_NODE.blank]!.create({ id }));
  if (padR) nodes.push(schema.text(" "));
  const tr = state.tr.replaceWith(from, to, Fragment.from(nodes));
  tr.setSelection(TextSelection.create(tr.doc, from + (padL ? 1 : 0) + 1));
  return tr;
}

