// Beta feedback 2026-10-08 (PDF import figures, slice 1): a figure the model
// did not pair stayed in the panel's strip with no way to put it on a
// question. These are the pure halves of the strip's status tag and its
// "Use with item…" control, and of a set card's "Add a figure…" — the panel
// owns the state and the rendering.

/** The fields of a proposed set these helpers read and write. */
export interface FigureSetShape {
  id: string;
  figures: number[];
  item_indexes: number[];
}

/** "item 3" / "items 3–5" for a set's block (indexes are 0-based). */
export function itemRangeLabel(indexes: readonly number[]): string {
  if (indexes.length === 0) return "";
  const first = indexes[0]! + 1;
  const last = indexes[indexes.length - 1]! + 1;
  return first === last ? `item ${first}` : `items ${first}–${last}`;
}

/** The strip's tag for figure `n`: the blocks it is shown with, or null when
 * no set uses it ("Not used"). */
export function figureUseLabel(sets: readonly FigureSetShape[], n: number): string | null {
  const using = sets.filter((s) => s.figures.includes(n));
  if (using.length === 0) return null;
  return `Used with ${using.map((s) => itemRangeLabel(s.item_indexes)).join(", ")}`;
}

/** Put figure `n` with candidate `index`: into the set that already holds
 * that question, else a new set of one (a stimulus card with the picture
 * above the question — the shape the adjacency fallback makes). */
export function attachFigure<S extends FigureSetShape>(
  sets: readonly S[],
  n: number,
  index: number,
  makeSet: (index: number, figures: number[]) => S,
): S[] {
  const holder = sets.find((s) => s.item_indexes.includes(index));
  if (!holder) return [...sets, makeSet(index, [n])];
  if (holder.figures.includes(n)) return [...sets];
  return sets.map((s) => (s.id === holder.id ? { ...s, figures: [...s.figures, n] } : s));
}

/** One line of a stem for a dropdown option: markdown emphasis, math
 * delimiters and blank markers out, whitespace collapsed, cut at `max`. */
export function stemSnippet(stem: string, max = 60): string {
  const plain = stem
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[[^\]]*\]\]/g, "___")
    .replace(/\*+|(?<!\\)\$/g, "")
    .replace(/\\\$/g, "$")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
