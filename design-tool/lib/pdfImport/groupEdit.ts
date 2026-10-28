// Page groups in the import review (2026-10-28): the same "same page" and
// "start a new page here" controls the editor has, over the review's
// proposed sets (indexes into the candidates, nothing saved until Add). A
// proposed set is a page group when it would be one once added: no text, no
// figure (a figure becomes stimulus text on Add), no sources, two or more
// questions. Pure — the panel holds the state.

import { isPageGroup } from "@/lib/authoring/pageGroup";

export interface GroupableSet {
  id: string;
  stimulus: string;
  figures: number[];
  item_indexes: number[];
  sources: readonly unknown[];
  needs_figure?: boolean;
}

export function isProposedPageGroup(set: GroupableSet): boolean {
  return set.figures.length === 0 && !set.needs_figure && isPageGroup(set, set.item_indexes.length);
}

/**
 * "Start a new page here" at candidate `index` inside group `set`: the
 * questions from `index` on leave it. A half of two or more stays (the tail
 * as a new group with `tailId`); a half of one question is loose again.
 * Returns the sets that replace `set` (zero, one or two of them).
 */
export function splitProposedGroup<S extends GroupableSet>(set: S, index: number, tailId: string): S[] {
  const at = set.item_indexes.indexOf(index);
  if (at <= 0) return [set];
  const head = set.item_indexes.slice(0, at);
  const tail = set.item_indexes.slice(at);
  const out: S[] = [];
  if (head.length >= 2) out.push({ ...set, item_indexes: head });
  if (tail.length >= 2) out.push({ ...set, id: tailId, item_indexes: tail });
  return out;
}

/** The loose question just above a set joins it ("… below"). */
export function prependToSet<S extends GroupableSet>(set: S, index: number): S {
  return set.item_indexes[0] === index + 1 ? { ...set, item_indexes: [index, ...set.item_indexes] } : set;
}
