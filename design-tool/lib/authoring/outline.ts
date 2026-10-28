/**
 * R-6 / R-7 (docs/editor-redesign-design.md, Phase 4 slice B): the pure
 * position logic behind the new editor's outline rail, its "+" insertion
 * points and choice reordering. No React, no DOM, so it is unit-tested
 * headlessly (test/authoring-outline.test.ts).
 *
 * The unit of movement in the question list is a BLOCK: a lone question, or
 * all the questions of one item set (shared stimulus). The reorder route
 * refuses an order that splits a set (`reorder_would_split_set`), and moving
 * whole blocks can never produce one — the same rule the current editor's
 * Move up / Move down follows.
 */

export interface Positioned {
  id: string;
  item_set_id?: string | null;
}

export interface OutlineBlock<T extends Positioned> {
  /** Stable across moves: the set id for a set, else the question's id. */
  key: string;
  setId: string | null;
  items: T[];
  /** Index of the block's first question in the full list. */
  start: number;
}

/** Contiguous blocks in list order. */
export function outlineBlocks<T extends Positioned>(list: readonly T[]): OutlineBlock<T>[] {
  const blocks: OutlineBlock<T>[] = [];
  list.forEach((it, i) => {
    const last = blocks[blocks.length - 1];
    const setId = it.item_set_id ?? null;
    if (last && setId && last.setId === setId) last.items.push(it);
    else blocks.push({ key: setId ?? it.id, setId, items: [it], start: i });
  });
  return blocks;
}

/**
 * Would this order split an item set? Mirrors `splitSetInOrder` in
 * lib/api/itemSets.ts (the server stays the authority): a set's questions
 * must sit next to each other.
 */
export function splitsSet(list: readonly Positioned[]): boolean {
  const closed = new Set<string>();
  let current: string | null = null;
  for (const it of list) {
    const setId = it.item_set_id ?? null;
    if (setId !== current) {
      if (current) closed.add(current);
      if (setId && closed.has(setId)) return true;
      current = setId;
    }
  }
  return false;
}

/** Move block `from` to block index `to` (drag). Null when nothing moves. */
export function moveBlockTo<T extends Positioned>(list: readonly T[], from: number, to: number): T[] | null {
  const blocks = outlineBlocks(list);
  if (from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) return null;
  return moveInList(blocks, from, to).flatMap((b) => b.items);
}

/** Move the block holding `itemId` one place up (-1) or down (+1) (click path). */
export function moveBlockBy<T extends Positioned>(list: readonly T[], itemId: string, delta: -1 | 1): T[] | null {
  const blocks = outlineBlocks(list);
  const from = blocks.findIndex((b) => b.items.some((i) => i.id === itemId));
  if (from < 0) return null;
  return moveBlockTo(list, from, from + delta);
}

/** A copy of `list` with the entry at `from` moved to `to` (dnd-kit's arrayMove). */
export function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/**
 * The list indexes where a new question may go: before every block and after
 * the last one. Never inside a set — a new question belongs to no set, so
 * putting it between two of a set's questions would split the set.
 */
export function insertionSlots(list: readonly Positioned[]): number[] {
  const slots = outlineBlocks(list).map((b) => b.start);
  slots.push(list.length);
  return slots;
}

/** The slot after the block holding `itemId` (the "/" shortcut on a card). */
export function slotAfter(list: readonly Positioned[], itemId: string): number {
  const block = outlineBlocks(list).find((b) => b.items.some((i) => i.id === itemId));
  return block ? block.start + block.items.length : list.length;
}

/**
 * Where a "/" is typed, not a shortcut. `math-field` is MathLive's element
 * (graph expressions, the graph item's board): its keys arrive from a
 * contenteditable inside its shadow root, so outside the field the event's
 * target is the `<math-field>` host, which the contenteditable selector
 * does not match.
 */
export const TEXT_ENTRY_SELECTOR = "input, textarea, select, [contenteditable='true'], math-field";

/**
 * Pure: whether a keydown on a question card is the "/" shortcut for the add
 * menu. Not with a modifier, not inside a text field, and not when something
 * inside the card already handled the key (MathLive turns "/" into a fraction
 * and calls preventDefault without stopping propagation).
 */
export function slashOpensInsertMenu(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  inTextField: boolean;
}): boolean {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return false;
  return !e.defaultPrevented && !e.inTextField;
}

/** Insert `item` at `index` (clamped to the list). */
export function insertAt<T>(list: readonly T[], item: T, index: number): T[] {
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}

function questionRange(start: number, size: number): string {
  return size === 1 ? `question ${start + 1}` : `questions ${start + 1} to ${start + size}`;
}

/**
 * What the live region says after a block moves (WCAG 2.2 SC 2.5.7's click
 * path and the drag both announce). `before` / `after` are the full lists.
 */
export function blockMoveAnnouncement<T extends Positioned>(
  before: readonly T[],
  after: readonly T[],
  movedId: string,
): string {
  const was = outlineBlocks(before).find((b) => b.items.some((i) => i.id === movedId));
  const now = outlineBlocks(after).find((b) => b.items.some((i) => i.id === movedId));
  if (!was || !now) return "";
  const size = was.items.length;
  const label = size === 1 ? `Question ${was.start + 1}` : `Questions ${was.start + 1} to ${was.start + size} (one stimulus)`;
  if (was.start === now.start) return `${label} did not move.`;
  const verb = size === 1 ? "is" : "are";
  return `${label} moved. ${size === 1 ? "It" : "They"} ${verb} now ${questionRange(now.start, size)} of ${after.length}.`;
}

/** A choice's letter by position (A, B, … Z, AA, AB …), as the preview shows it. */
export function choiceLetter(index: number): string {
  const letter = (n: number) => String.fromCharCode(65 + n);
  return index < 26 ? letter(index) : choiceLetter(Math.floor(index / 26) - 1) + letter(index % 26);
}

/** What the live region says after a choice moves. */
export function choiceMoveAnnouncement(from: number, to: number, count: number): string {
  if (from === to) return `Choice ${choiceLetter(from)} did not move.`;
  return `Choice ${choiceLetter(from)} moved. It is now choice ${choiceLetter(to)} of ${count}.`;
}

/**
 * The text one card's choice live region shows: the last move's message in
 * the question it happened in, nothing anywhere else (F-4, 2026-10-27 — a
 * shared message was read once per multiple-choice card).
 */
export function choiceMessageFor(last: { itemId: string; text: string } | null, itemId: string): string {
  return last?.itemId === itemId ? last.text : "";
}
