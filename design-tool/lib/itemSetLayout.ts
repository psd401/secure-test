// C-8(b) (docs/multi-source-stimulus-design.md): a stimulus set that gains
// sources defaults to the side-by-side layout, because a set with sources
// and no picked layout reads poorly inline. Pure so it is unit-testable
// without the editor's React state; the editor calls it whenever it adds
// the first source to a set.

/**
 * The layout a set should carry after a source is added.
 *
 * Only flips `inline` -> `side_by_side`, and only on the *first* source
 * (sourceCountBefore === 0) — a teacher who has already chosen `own_page`
 * or `side_by_side` keeps that choice, and adding a second/third source
 * never flips anything back.
 */
export function defaultLayoutAfterAddingSource(
  current: "inline" | "own_page" | "side_by_side",
  sourceCountBefore: number,
): "inline" | "own_page" | "side_by_side" {
  if (current === "inline" && sourceCountBefore === 0) return "side_by_side";
  return current;
}
