// Beta report 2026-10-28 (James): an imported stimulus set without sources
// starts on `own_page` — the stimulus on its own page, then one page per
// question with the stimulus collapsed above it — not `inline` (every
// question on one page), for clarity on math tests. A set with sources keeps
// D-2's `side_by_side`. This is only the default a proposal card offers; the
// teacher can change it before Add, and the editor's own rule
// (`defaultLayoutAfterAddingSource`) is separate. Pure and client-safe: the
// import route and the review panel share it.

export type ProposedSetLayout = "inline" | "own_page" | "side_by_side";

export function proposedSetLayout(hasSources: boolean): ProposedSetLayout {
  return hasSources ? "side_by_side" : "own_page";
}
