import type { ItemRow } from "@/db/schema";

/**
 * Slice 70: an item whose stored shape cannot produce a valid bundle.
 *
 * Reachable only by a direct database write or a legacy row — the items API
 * requires match `pairs` and order `sequence` to have at least two entries on
 * every write (lib/api/items.ts). Hotspot is the exception and is deliberately
 * draft-friendly, which is why it is NOT checked here: a hotspot with no image
 * or regions is a legitimate authoring state and the client already says so.
 *
 * The reason this needs its own check rather than being left to the schema is
 * what the failure looked like without it: `ItemBundleSchema.parse` threw an
 * unhandled ZodError out of the route, so a teacher pressing Export got a bare
 * 500 and no indication which of their items was the problem. The stored data
 * is anomalous either way; the difference is whether anyone can act on it.
 */
export class IncompleteItemError extends Error {
  constructor(
    readonly itemId: string,
    readonly detail: string,
  ) {
    super(`item ${itemId} cannot be bundled: ${detail}`);
    this.name = "IncompleteItemError";
  }
}

export function assertItemsAreBundleable(rows: readonly ItemRow[]): void {
  for (const row of rows) {
    if (row.type === "match" && (row.config?.pairs?.length ?? 0) < 2) {
      throw new IncompleteItemError(row.id, "a match item needs at least two pairs");
    }
    if (row.type === "order" && (row.config?.sequence?.length ?? 0) < 2) {
      throw new IncompleteItemError(row.id, "an order item needs at least two entries");
    }
    // E3 slice 1: the API requires at least one column and one row on every
    // write; a row without them is a direct DB write, and the bundle schemas
    // would reject it anonymously.
    if (
      row.type === "table" &&
      ((row.config?.columns?.length ?? 0) < 1 || (row.config?.rows?.length ?? 0) < 1)
    ) {
      throw new IncompleteItemError(row.id, "a table item needs at least one column and one row");
    }
  }
}
