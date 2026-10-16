// The `?section=` rule shared by the results matrix and the scoring queue
// (Hybrid transparency slice 2, decision 5.4). Pure, so the queue's client
// component can use it; lib/scoring/results.ts re-exports both names.

/** The `?section=` value that means "the rows with no section resolved". */
export const NO_SECTION = "__none__";

/** Whether a row's resolved section passes a filter — "" means every row. */
export function matchesSectionFilter(section: string | null, filter: string): boolean {
  if (filter === "") return true;
  if (filter === NO_SECTION) return !section;
  return section === filter;
}
