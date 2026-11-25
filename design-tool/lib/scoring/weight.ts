/**
 * B1 point weighting (docs/point-weighting-design.md): a teacher sets what a
 * question is worth (`items.points`), and every score on it is the natural
 * score scaled to that weight. `NULL` = the natural maximum, unchanged.
 *
 * No imports on purpose: `lib/scoring/auto.ts` and `lib/scoring/results.ts`
 * both use this, and neither may pull the other in.
 */

/** Round to 2 decimals (the design's rounding rule). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A natural `{points, max}` put on this item's weight. A null/undefined
 * weight (or a natural max of 0) leaves the score as it is. Full credit is
 * exactly `weight`, so `points <= max_points` always holds; anything less is
 * `round2(points × weight / natural)`.
 */
export function applyWeight(
  points: number,
  naturalMax: number,
  weight: number | null | undefined,
): { points: number; max_points: number } {
  if (weight == null || !(naturalMax > 0) || weight === naturalMax) {
    return { points, max_points: naturalMax };
  }
  if (points >= naturalMax) return { points: weight, max_points: weight };
  return {
    points: Math.min(weight, round2((points * weight) / naturalMax)),
    max_points: weight,
  };
}
