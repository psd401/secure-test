/**
 * An item's maximum points — the rules every score path shares. Client-safe
 * (no DB, no server-only imports): the editor and the outline rail run the
 * same rules on an ItemView (`viewMaxInput`), so what a teacher sees is what
 * the server scores against. B1 (docs/point-weighting-design.md) added the
 * teacher's weight (`items.points`) on top of the natural maximum.
 */
import type { ItemRow } from "@/db/schema";
import { rubricMaxPoints } from "@/lib/ai/essayScorer/scoreCore";
import { fillBlankMaxPoints, tableMaxPoints } from "@/lib/scoring/auto";
import { graphMaxPoints } from "@secure-test/graphing/server";
import { applyWeight } from "@/lib/scoring/weight";

/** D-R1: an item's constant maximum — the same rule the manual-score route
 * pins (`app/api/responses/[responseId]/score/route.ts`): the rubric max
 * when the item has a rubric, the keyed-cell count for a table, the keyed-blank count for a
 * fill_blank, else 1.
 * Exported for R1: the item-analytics footer and the per-student page divide
 * by the same constant this file sums into `max_points`. */
/** What the max-point rules read: a row's type and config, and its weight (required). */
export type MaxPointsInput = Pick<ItemRow, "type" | "config"> & { points: number | null };

export function itemMaxPoints(
  item: Pick<ItemRow, "type" | "config"> & { points: number | null },
): number {
  // B1 (docs/point-weighting-design.md): the teacher's weight wins; NULL =
  // natural max. `points` is required so a caller that selects a narrow
  // column set fails typecheck instead of silently disagreeing with the
  // stored (weighted) scores; an ItemView goes through `viewMaxInput`.
  return item.points ?? naturalMaxPoints(item);
}

/**
 * B1: the maximum a teacher ENTERS a hand score against — the rubric max on a
 * rubric item (criterion picks are in rubric points; the write scales them,
 * `scaleEntry`), else the weighted item max. The manual-score check and
 * the review queue both read this, so they cannot drift apart again.
 */
export function entryMaxPoints(
  item: Pick<ItemRow, "type" | "config"> & { points: number | null },
): number {
  return item.config.rubric ? rubricMaxPoints(item.config.rubric) : itemMaxPoints(item);
}

/**
 * B1 (D1): a score entered against `entryMaxPoints` as the score row to
 * store. A rubric total is scaled to the item's weight (criterion scores stay
 * in rubric points); anything else was already entered on the item's weight.
 */
export function scaleEntry(
  item: Pick<ItemRow, "config"> & { points: number | null },
  points: number,
  maxPoints: number,
): { points: number; max_points: number } {
  return item.config.rubric
    ? applyWeight(points, maxPoints, item.points)
    : { points, max_points: maxPoints };
}

/** B1: an item's maximum before any teacher weight — the D-R1 rule above. */
export function naturalMaxPoints(item: Pick<ItemRow, "type" | "config">): number {
  if (item.config.rubric) return rubricMaxPoints(item.config.rubric);
  if (item.type === "table") return tableMaxPoints(item.config);
  // FB slice 1: one point per keyed blank (D-2), every blank when keyless.
  if (item.type === "fill_blank") return fillBlankMaxPoints(item.config);
  // Graphing calculator D-9: per-object scoring has a point per key shape.
  if (item.type === "graph" && item.config.graph_board && item.config.graph_key) {
    return graphMaxPoints(item.config.graph_board, item.config.graph_key);
  }
  return 1;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/**
 * B1 slice 2: the line under the editor's Points field. A partial-credit
 * type names each part's share ("Worth 6 · 1.5 per keyed cell"); a rubric
 * item names its scale ("Rubric is out of 8 · scaled to 4"). Null when there
 * is nothing to add to the field itself (an all-or-nothing type, or a
 * partial-credit item with no parts yet).
 */
export function pointsHint(
  item: Pick<ItemRow, "type" | "config"> & { points: number | null },
): string | null {
  const natural = naturalMaxPoints(item);
  const worth = itemMaxPoints(item);
  if (item.config.rubric) {
    if (natural <= 0) return null;
    return worth === natural
      ? `Rubric is out of ${fmt(natural)}`
      : `Rubric is out of ${fmt(natural)} · scaled to ${fmt(worth)}`;
  }
  const part = partName(item);
  if (!part || natural <= 0) return null;
  const share = worth / natural;
  return `Worth ${fmt(worth)} · ${fmt(share)} per ${part}`;
}

/** What one point of a partial-credit item is counted per, or null. */
function partName(item: Pick<ItemRow, "type" | "config">): string | null {
  if (item.type === "table") {
    const keyed = Object.values(item.config.cell_keys ?? {}).some((c) => Object.keys(c).length > 0);
    return keyed ? "keyed cell" : "cell";
  }
  if (item.type === "fill_blank") return "blank";
  // A keyless graph is worth 1 (naturalMaxPoints), so it has no parts yet.
  if (item.type === "graph" && item.config.graph_board && item.config.graph_key && item.config.graph_key.scoring !== "all") {
    return "shape";
  }
  return null;
}
