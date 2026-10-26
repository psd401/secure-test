// Upper bounds for list and record schemas that parse request data
// (2026-10-25).
//
// zod 4.6.6+ checks a collection's size constraint before validating its
// elements (advisory GHSA-mrhx-c7xc-m3w5); a list without one still keeps an
// issue object per failing element — measured at ~150-180 MB of heap for a
// 2 MB array of 1,000,000 wrong-typed values, against ~0 MB with `.max()`.
// Every list a request can reach therefore carries one of these bounds,
// chosen far above real data (production, 2026-10-25: the largest stored item
// is 8.7 KiB; the accommodation catalog has 58 ids). design-tool's
// test/list-bounds.test.ts refuses an unbounded list or record in the request
// schemas.
import { z } from "zod";

/** Lists inside one item or one answer: choices, pairs, blanks, table rows,
 * rubric levels and criteria, selected ids. */
export const MAX_ITEM_LIST = 100;

/** Assessment-wide lists: a bundle's items and item sets, item / attempt id
 * lists, accommodation ids. */
export const MAX_ASSESSMENT_LIST = 1000;

/**
 * `z.record(key, value)` that refuses more than `max` keys BEFORE validating
 * a single value. Records amplify like lists (zod 4.6.7, 1,000,000 failing
 * values: 1,000,000 issues, ~200-240 MB), zod has no size constraint for
 * them, and a `.refine()` on key count runs only after every value has been
 * checked. The key count is checked first here and `.pipe` stops on failure:
 * measured, 1 issue and ~0 MB. A non-object passes the count check so the
 * record reports its own type error.
 */
export function boundedRecord<V extends z.ZodType>(key: z.ZodString, value: V, max: number) {
  return z
    .custom<Record<string, unknown>>(
      (v) =>
        typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length <= max,
      { message: `at most ${max} keys` },
    )
    .pipe(z.record(key, value));
}
