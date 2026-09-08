/**
 * R2 print report (docs/reporting-design.md): the numbers on page one.
 *
 * TEMPORARY HOME. R1 builds `lib/reporting/analytics.ts` (p-value, % answered,
 * per-choice counts, one query over `responses` + `scores`). These helpers
 * exist so the print view could be built in parallel with it; once
 * `analytics.ts` lands, `summarizeItems` should be replaced by a call into it
 * and this file should keep only `summarizeCohort` (which analytics does not
 * cover). Nothing here queries — it is a pure fold over `buildResults` output,
 * so it only ever sees FINAL scores, exactly like the matrix and the CSV.
 */

import type { AssessmentResults, ResultsRow } from "@/lib/scoring/results";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ItemStat {
  id: string;
  /** Zero-based, as `results.items` carries it; the report prints Q<position+1>. */
  position: number;
  type: string;
  /**
   * The item's max as the scored cells report it — null when no row on this
   * page has a final score for the item, so nothing is known about its
   * denominator here. (`buildResults` only exposes the ASSESSMENT-level
   * constant max, not the per-item one; `analytics.ts` should supply the
   * constant instead when it lands.)
   */
  max_points: number | null;
  /** Rows with a final score for this item — the denominator of the mean. */
  scored_count: number;
  /** Mean final points over `scored_count` rows, 2 dp; null when none. */
  mean_points: number | null;
  /** mean_points / max_points as an integer percent; null when either is null. */
  p_value: number | null;
}

export function summarizeItems(
  items: AssessmentResults["items"],
  rows: readonly ResultsRow[],
): ItemStat[] {
  return items.map((item, index) => {
    let sum = 0;
    let count = 0;
    let max: number | null = null;
    for (const row of rows) {
      const cell = row.cells[index];
      if (!cell || cell.status !== "final" || cell.points === null) continue;
      sum += cell.points;
      count += 1;
      if (cell.max_points !== null) max = cell.max_points;
    }
    const mean = count > 0 ? sum / count : null;
    return {
      id: item.id,
      position: item.position,
      type: item.type,
      max_points: max,
      scored_count: count,
      mean_points: mean === null ? null : round2(mean),
      p_value:
        mean === null || max === null || max === 0
          ? null
          : Math.round((100 * mean) / max),
    };
  });
}

export interface CohortSummary {
  handed_in: number;
  /** Rows with nothing left to score — the only rows the means are over. */
  complete_count: number;
  /** Rows still carrying unscored items; the "k of N" line. */
  incomplete_count: number;
  /** The assessment-level constant denominator (D-R1); null with no rows. */
  max_points: number | null;
  /** Mean total over complete rows, 2 dp; null when none are complete. */
  mean_total: number | null;
  /** mean_total / max_points as an integer percent; null on the same terms. */
  mean_percent: number | null;
  /** Earliest / latest hand-in ISO strings among the rows; null when none. */
  first_submitted: string | null;
  last_submitted: string | null;
}

export function summarizeCohort(rows: readonly ResultsRow[]): CohortSummary {
  const complete = rows.filter((r) => r.unscored_count === 0);
  const maxPoints = rows.length > 0 ? rows[0]!.max_points : null;
  const meanTotal =
    complete.length > 0
      ? complete.reduce((s, r) => s + r.total_points, 0) / complete.length
      : null;
  const submitted = rows
    .map((r) => r.submitted_at)
    .filter((v): v is string => !!v)
    .sort();
  return {
    handed_in: rows.length,
    complete_count: complete.length,
    incomplete_count: rows.length - complete.length,
    max_points: maxPoints,
    mean_total: meanTotal === null ? null : round2(meanTotal),
    mean_percent:
      meanTotal === null || !maxPoints ? null : Math.round((100 * meanTotal) / maxPoints),
    first_submitted: submitted[0] ?? null,
    last_submitted: submitted[submitted.length - 1] ?? null,
  };
}

/** Teacher-facing wording for an item type; unknown types de-underscore. */
const TYPE_LABELS: Record<string, string> = {
  multiple_choice_single: "Multiple choice",
  multiple_choice_multi: "Multiple choice (multi)",
  short_text: "Short text",
  essay: "Essay",
  match: "Match",
  order: "Order",
  hotspot: "Hotspot",
  drawing_upload: "Drawing",
  table: "Table",
};

export function itemTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}
